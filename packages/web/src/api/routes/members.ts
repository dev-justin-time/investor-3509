import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { actorOf, memberProc, publicProc, signedIn, type Member } from "../middleware/auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { LEVELS, ONGOING_UNLOCK_CENTS, levelConfig, scoreBand, trustFactors, weekKey } from "../lib/economy";
import { audit, audited } from "../lib/services/audit";
import { idempotencyKey, isUniqueViolation, once } from "../lib/services/idempotency";
import { addLedger, chargeService } from "../lib/services/ledger";
import { addNotice } from "../lib/services/notices";
import { isAccredited } from "../lib/services/tickets";
import { runTx, type Db } from "../lib/services/tx";
import { spendPoints } from "../lib/services/wallet";

const worldEnum = z.enum(["underground", "lab", "prestige"]);
const brandEnum = z.enum(["forge", "orbital", "sole", "hub"]);

/** Fields any visitor may see about a member. Never wallet, email or identity status. */
const publicColumns = {
  id: schema.members.id,
  handle: schema.members.handle,
  displayName: schema.members.displayName,
  role: schema.members.role,
  level: schema.members.level,
  clout: schema.members.clout,
  homeBrand: schema.members.homeBrand,
  bio: schema.members.bio,
  createdAt: schema.members.createdAt,
};

async function memberStats(tx: Db, memberId: number) {
  const [draws, investments, tasks, notices, verified] = await Promise.all([
    tx.select().from(schema.draws).where(eq(schema.draws.memberId, memberId)),
    tx.select().from(schema.investments).where(and(eq(schema.investments.memberId, memberId), eq(schema.investments.kind, "primary"))),
    tx.select().from(schema.tasks).where(eq(schema.tasks.memberId, memberId)),
    tx.select().from(schema.notices).where(and(eq(schema.notices.memberId, memberId), eq(schema.notices.resolved, false))),
    tx
      .select({ count: sql<number>`count(*)` })
      .from(schema.milestones)
      .innerJoin(schema.projects, eq(schema.milestones.projectId, schema.projects.id))
      .where(and(eq(schema.projects.creatorId, memberId), eq(schema.milestones.status, "verified"))),
  ]);
  return {
    draws,
    investments,
    tasksApproved: tasks.filter((t) => t.status === "approved").length,
    openNotices: notices,
    defaults: notices.filter((n) => n.kind === "default_notice" || n.kind === "foreclosure").length,
    milestonesVerified: Number(verified[0]?.count ?? 0),
  };
}

async function freshMember(tx: Db, id: number) {
  const [row] = await tx.select().from(schema.members).where(eq(schema.members.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Member not found" });
  return row;
}

async function scoreFile(viewer: Member, target: Member) {
  const stats = await memberStats(db, target.id);
  const ageDays = Math.max(0, Math.round((Date.now() - new Date(target.createdAt).getTime()) / 86400000));
  const trust = trustFactors({
    decisionsMade: stats.draws.filter((d) => d.decision !== "pending").length,
    decisionsPending: stats.draws.filter((d) => d.decision === "pending").length,
    investments: stats.investments.length,
    tasksApproved: stats.tasksApproved,
    defaults: stats.defaults,
    milestonesVerified: stats.milestonesVerified,
    kycStatus: target.kycStatus,
    accountAgeDays: ageDays,
  });
  if (trust.score !== target.trustScore) {
    await db.update(schema.members).set({ trustScore: trust.score }).where(eq(schema.members.id, target.id));
  }
  return {
    self: target.id === viewer.id,
    handle: target.handle,
    displayName: target.displayName,
    trust: { ...trust, band: scoreBand(trust.score) },
    social: {
      score: target.socialScore,
      band: scoreBand(target.socialScore),
      factors: [
        { label: "Clout", detail: "Earned by marketing and diligence others acted on", points: target.clout, max: 2000 },
        { label: "Verdict weight", detail: "How often your try/bye call matched the outcome", points: Math.round(target.socialScore / 10), max: 100 },
      ],
    },
    visibility:
      "Scores are private. You always see your own file. Looking up another handle needs administrator-approved simulated accreditation — paid levels do not grant it — and every lookup is logged to that member.",
  };
}

export const members = {
  /** The caller's account and passport (both null when signed out). Safe to call anonymously. */
  me: publicProc.handler(({ context }) => ({
    user: context.user ? { id: context.user.id, email: context.user.email, name: context.user.name } : null,
    member: context.member,
  })),

  /**
   * First-time passport for the signed-in account. Never claims an existing passport —
   * seeded/QA passports stay unclaimed, and accounts are never matched by email.
   */
  onboard: signedIn
    .input(
      z.object({
        displayName: z.string().trim().min(2).max(60),
        handle: z.string().trim().toLowerCase().min(3).max(24).regex(/^[a-z0-9_]+$/, "lowercase letters, numbers and underscores only"),
        world: worldEnum.default("underground"),
        homeBrand: brandEnum.default("forge"),
        track: z.enum(["backer", "creator", "both"]).default("both"),
        bio: z.string().trim().max(280).optional(),
      }),
    )
    .handler(({ input, context }) =>
      audited(actorOf(context), "members.onboard", undefined, async () => {
        if (context.member) {
          logDecision("onboard", "Account already owns a passport", { memberId: context.member.id });
          return context.member;
        }
        try {
          return await runTx("members.onboard", async (tx) => {
            const [taken] = await tx.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.handle, input.handle));
            if (taken) throw new ORPCError("CONFLICT", { message: "That handle is taken" });
            const [member] = await tx
              .insert(schema.members)
              .values({
                authUserId: context.user.id,
                email: context.user.email.toLowerCase(),
                displayName: input.displayName,
                handle: input.handle,
                world: input.world,
                homeBrand: input.homeBrand,
                role: input.track === "backer" ? "member" : "creator",
                bio: input.bio || null,
              })
              .returning();
            await tx.insert(schema.walletEntries).values({ memberId: member.id, deltaCents: member.walletCents, balanceAfterCents: member.walletCents, reason: "opening simulated club credit" });
            await addLedger(tx, { kind: "opening_credit", amountCents: member.walletCents, memberId: member.id, bucket: "member", note: "Opening simulated club credit (no card charged)" });
            await addNotice(tx, {
              memberId: member.id,
              kind: "grace",
              title: "Welcome — nothing here can bankrupt you",
              body: "Your starting balance is simulated club credit. Level 0 gives you three draws a week, a $10 cap per project, and an answer required before the next draw unlocks.",
              recoveryPath: "Request a simulated identity review from your portfolio whenever you like. Skipping it only limits Orbital Works and score lookups.",
            });
            await audit(tx, { memberId: member.id, userId: context.user.id }, { action: "members.onboard", outcome: "accepted", targetType: "member", targetId: member.id, summary: `Passport @${member.handle} created` });
            return member;
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ORPCError("CONFLICT", { message: "That handle or email already belongs to another passport. Pick another handle, or sign in with the account that owns it." });
          }
          throw error;
        }
      }),
    ),

  /** Public profile card. */
  get: publicProc.input(z.object({ memberId: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.select(publicColumns).from(schema.members).where(eq(schema.members.id, input.memberId));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Member not found" });
    return row;
  }),

  byHandle: publicProc.input(z.object({ handle: z.string() })).handler(async ({ input }) => {
    const [row] = await db.select(publicColumns).from(schema.members).where(eq(schema.members.handle, input.handle.toLowerCase()));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "No member with that handle" });
    return row;
  }),

  list: publicProc.handler(() => db.select(publicColumns).from(schema.members).orderBy(desc(schema.members.clout)).limit(50)),

  setWorld: memberProc.input(z.object({ world: worldEnum })).handler(async ({ input, context }) => {
    await db.update(schema.members).set({ world: input.world }).where(eq(schema.members.id, context.member.id));
    logDecision("theme", "World saved to passport", { memberId: context.member.id, world: input.world });
    return { world: input.world };
  }),

  /** Dashboard summary for the signed-in passport. */
  dashboard: memberProc.handler(async ({ context }) => {
    const member = await freshMember(db, context.member.id);
    const stats = await memberStats(db, member.id);
    const cfg = levelConfig(member.level);
    const wk = weekKey();
    const weekDraws = stats.draws.filter((d) => d.weekKey === wk);
    const pending = stats.draws.find((d) => d.decision === "pending");

    const positions = await db
      .select({ investment: schema.investments, project: schema.projects })
      .from(schema.investments)
      .innerJoin(schema.projects, eq(schema.investments.projectId, schema.projects.id))
      .where(and(eq(schema.investments.memberId, member.id), eq(schema.investments.kind, "primary")))
      .orderBy(desc(schema.investments.createdAt));
    const [equity] = await db
      .select({ bp: sql<number>`coalesce(sum(${schema.equityPositions.equityBp}), 0)` })
      .from(schema.equityPositions)
      .innerJoin(schema.projects, eq(schema.equityPositions.projectId, schema.projects.id))
      .where(and(eq(schema.equityPositions.memberId, member.id), sql`${schema.projects.creatorId} <> ${member.id}`));

    const investedCents = positions.reduce((s, p) => s + p.investment.amountCents, 0);
    const liveCents = positions
      .filter((p) => !["foreclosed", "cancelled", "redistributed"].includes(p.project.status))
      .reduce((s, p) => s + p.investment.amountCents, 0);

    return {
      member,
      level: cfg,
      nextLevel: LEVELS[member.level + 1] ?? null,
      week: {
        key: wk,
        used: weekDraws.length,
        allowance: cfg.drawsPerWeek,
        remaining: Math.max(0, cfg.drawsPerWeek - weekDraws.length),
        pendingProjectId: pending?.projectId ?? null,
      },
      portfolio: {
        positions: positions.slice(0, 25),
        count: positions.length,
        investedCents,
        liveCents,
        heldCents: positions.reduce((s, p) => s + p.investment.heldCents, 0),
        pointsEarned: positions.reduce((s, p) => s + p.investment.pointsAwarded, 0),
        equityBp: Number(equity?.bp ?? 0),
      },
      notices: stats.openNotices,
    };
  }),

  /** Private score with every factor spelled out. */
  scores: memberProc.input(z.object({ targetHandle: z.string().optional() })).handler(async ({ input, context }) => {
    const viewer = await freshMember(db, context.member.id);
    const handle = input.targetHandle?.trim().toLowerCase();
    if (!handle || handle === viewer.handle) return scoreFile(viewer, viewer);

    return audited(actorOf(context), "members.scoreLookup", { type: "handle", id: handle }, async () => {
      if (!isAccredited(viewer)) {
        throw new ORPCError("FORBIDDEN", {
          message: "Looking up another member's file needs administrator-approved simulated accreditation. Paid levels and admin roles do not bypass it. Your own file is always open to you.",
        });
      }
      const [target] = await db.select().from(schema.members).where(eq(schema.members.handle, handle));
      if (!target) throw new ORPCError("NOT_FOUND", { message: "No member with that handle" });
      await runTx("members.scoreLookup", async (tx) => {
        await addNotice(tx, { memberId: target.id, kind: "score_lookup", title: "Private score lookup", body: `@${viewer.handle} viewed your private standing file.`, recoveryPath: "Every lookup is logged. Ask the house desk for an access audit at any time." });
        await audit(tx, actorOf(context), { action: "members.scoreLookup", outcome: "accepted", targetType: "member", targetId: target.id, summary: `Viewed @${target.handle}` });
      });
      return scoreFile(viewer, target);
    });
  }),

  levelUp: memberProc.input(z.object({ method: z.enum(["fee", "points"]), idempotencyKey })).handler(({ input, context }) => {
    const { idempotencyKey: key, ...payload } = input;
    return audited(actorOf(context), "members.levelUp", undefined, () =>
      once({ memberId: context.member.id, scope: "members.levelUp", key, payload }, async (tx) => {
        const member = await freshMember(tx, context.member.id);
        const next = LEVELS[member.level + 1];
        if (!next) throw new ORPCError("BAD_REQUEST", { message: "Top level already" });

        if (input.method === "points") {
          await spendPoints(tx, member.id, next.pointCost, `${next.name} unlock`);
          await addLedger(tx, { kind: "level_up", amountCents: 0, memberId: member.id, bucket: "member", note: `${next.name} unlocked with ${next.pointCost} points` });
        } else {
          await chargeService(tx, { kind: "level_up", amountCents: next.feeCents, memberId: member.id, note: `${next.name} unlock fee` });
        }
        // Conditional on the level we read, so two concurrent upgrades cannot skip a tier.
        const [updated] = await tx
          .update(schema.members)
          .set({ level: next.level, ...(next.level >= 2 ? { ongoingAccess: true } : {}) })
          .where(and(eq(schema.members.id, member.id), eq(schema.members.level, member.level)))
          .returning();
        if (!updated) throw new ORPCError("CONFLICT", { message: "Your level changed while this was processing. Refresh and try again." });
        await audit(tx, actorOf(context), { action: "members.levelUp", outcome: "accepted", targetType: "member", targetId: member.id, summary: `L${member.level} → L${next.level} via ${input.method}` });
        logDecision("levels", "Level raised", { memberId: member.id, level: next.level, method: input.method });
        return { level: updated.level, name: next.name, method: input.method };
      }),
    );
  }),

  unlockOngoing: memberProc.input(z.object({ idempotencyKey })).handler(({ input, context }) =>
    audited(actorOf(context), "members.unlockOngoing", undefined, () =>
      once({ memberId: context.member.id, scope: "members.unlockOngoing", key: input.idempotencyKey, payload: {} }, async (tx) => {
        const [claimed] = await tx
          .update(schema.members)
          .set({ ongoingAccess: true })
          .where(and(eq(schema.members.id, context.member.id), eq(schema.members.ongoingAccess, false)))
          .returning({ id: schema.members.id });
        if (!claimed) {
          logDecision("access", "Ongoing access already held; nothing charged", { memberId: context.member.id });
          return { ongoingAccess: true, chargedCents: 0 };
        }
        await chargeService(tx, { kind: "ongoing_unlock", amountCents: ONGOING_UNLOCK_CENTS, memberId: context.member.id, note: "Ongoing round access" });
        await audit(tx, actorOf(context), { action: "members.unlockOngoing", outcome: "accepted", targetType: "member", targetId: context.member.id, summary: "Ongoing access unlocked" });
        return { ongoingAccess: true, chargedCents: ONGOING_UNLOCK_CENTS };
      }),
    ),
  ),

  /** My own wallet movements since the authenticated ledger shipped. */
  walletHistory: memberProc.handler(({ context }) =>
    db.select().from(schema.walletEntries).where(eq(schema.walletEntries.memberId, context.member.id)).orderBy(desc(schema.walletEntries.id)).limit(60),
  ),

  leaderboard: publicProc.handler(() =>
    db
      .select({
        id: schema.members.id,
        handle: schema.members.handle,
        displayName: schema.members.displayName,
        level: schema.members.level,
        clout: schema.members.clout,
        points: schema.members.points,
        homeBrand: schema.members.homeBrand,
      })
      .from(schema.members)
      .orderBy(desc(schema.members.clout))
      .limit(12),
  ),
};
