import { z } from "zod";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { actorOf, memberProc, publicProc } from "../middleware/auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { CANCEL_CLAWBACK_RATE, ESCROW_FEE_CENTS, GRACE_DAYS, daysFromNow, pitchFeeCents, pointValueForStage } from "../lib/economy";
import { audit, audited } from "../lib/services/audit";
import { openCreatorPosition, positionOf } from "../lib/services/equity";
import { refundOnCancel } from "../lib/services/escrow";
import { idempotencyKey, once } from "../lib/services/idempotency";
import { addLedger, chargeService } from "../lib/services/ledger";
import { addNotice } from "../lib/services/notices";
import { lockProject } from "../lib/services/tickets";
import { runTx } from "../lib/services/tx";
import { debit, usd } from "../lib/services/wallet";

const riskEnum = z.enum(["low", "medium", "high"]);
const brandEnum = z.enum(["forge", "orbital", "sole"]);
const CLOSED = ["cancelled", "foreclosed", "redistributed", "closed"];

const ESCROW_VENDORS = [
  "Harbor & Vale Escrow (Wilmington, DE)",
  "Sierra Trust Services (Reno, NV)",
  "Meridian Fiduciary (Austin, TX)",
  "Northbridge Escrow Co. (Chicago, IL)",
  "Coastline Settlement Group (Tampa, FL)",
];

const MILESTONE_TEMPLATES = [
  { title: "Stage 1 — Proof it exists", requirement: "Working artifact, footage, or signed letter of intent posted to the project room." },
  { title: "Stage 2 — Proof someone wants it", requirement: "First paying customer, pre-order, or grant, with receipts in escrow." },
  { title: "Stage 3 — Proof it repeats", requirement: "Three consecutive months of revenue or a filed IP asset with an examiner number." },
  { title: "Stage 4 — Proof it scales", requirement: "Unit economics sheet plus a fulfilment or manufacturing agreement." },
  { title: "Stage 5 — Proof it pays members", requirement: "First distribution run through escrow to equity holders." },
];

export const projects = {
  feeQuote: publicProc
    .input(z.object({ capitalGoalCents: z.number().int().min(10000).max(100000000), riskTier: riskEnum }))
    .handler(({ input }) => {
      const fee = pitchFeeCents(input.capitalGoalCents, input.riskTier);
      return {
        pitchFeeCents: fee,
        escrowFeeCents: ESCROW_FEE_CENTS,
        totalCents: fee + ESCROW_FEE_CENTS,
        clawbackRate: CANCEL_CLAWBACK_RATE,
        explanation:
          "Pitch fee is $10 base plus a capital-goal and risk scale. Low risk at a $10,000 goal is $99. Escrow is a flat $200 retainer for the vetted professional, not house revenue. Cancel while backer money is still held and 25% of what is held is retained; funds already released at verified stages are never reversed.",
      };
    }),

  list: publicProc
    .input(z.object({ brand: brandEnum.optional(), status: z.string().optional(), category: z.string().optional() }).optional())
    .handler(async ({ input }) => {
      const rows = await db
        .select({ project: schema.projects, creator: { handle: schema.members.handle, displayName: schema.members.displayName } })
        .from(schema.projects)
        .innerJoin(schema.members, eq(schema.projects.creatorId, schema.members.id))
        .orderBy(desc(schema.projects.createdAt));
      return rows
        .filter((r) => (input?.brand ? r.project.brand === input.brand : true))
        .filter((r) => (input?.status ? r.project.status === input.status : true))
        .filter((r) => (input?.category ? r.project.category === input.category : true))
        .map((r) => ({ ...r.project, creatorHandle: r.creator.handle, creatorName: r.creator.displayName }));
    }),

  /** Public project room. Viewer figures come from the session, never from an input id. */
  get: publicProc.input(z.object({ projectId: z.number().int() })).handler(async ({ input, context }) => {
    const project = await lockProject(db, input.projectId);
    const [creator] = await db.select().from(schema.members).where(eq(schema.members.id, project.creatorId));
    const [ms, invs, cmts, equity, held] = await Promise.all([
      db.select().from(schema.milestones).where(eq(schema.milestones.projectId, project.id)).orderBy(schema.milestones.stage),
      db
        .select({ investment: schema.investments, member: { handle: schema.members.handle, displayName: schema.members.displayName } })
        .from(schema.investments)
        .innerJoin(schema.members, eq(schema.investments.memberId, schema.members.id))
        .where(and(eq(schema.investments.projectId, project.id), eq(schema.investments.kind, "primary")))
        .orderBy(desc(schema.investments.createdAt)),
      db
        .select({ comment: schema.comments, member: { handle: schema.members.handle, displayName: schema.members.displayName, level: schema.members.level } })
        .from(schema.comments)
        .innerJoin(schema.members, eq(schema.comments.memberId, schema.members.id))
        .where(eq(schema.comments.projectId, project.id))
        .orderBy(desc(schema.comments.createdAt)),
      db.select().from(schema.equityListings).where(and(eq(schema.equityListings.projectId, project.id), eq(schema.equityListings.status, "open"))),
      db
        .select({ cents: sql<number>`coalesce(sum(${schema.investments.heldCents}), 0)` })
        .from(schema.investments)
        .where(eq(schema.investments.projectId, project.id)),
    ]);

    const viewerId = context.member?.id ?? null;
    const mine = viewerId ? invs.filter((i) => i.investment.memberId === viewerId) : [];
    const viewerBp = viewerId ? await positionOf(db, project.id, viewerId) : 0;

    return {
      project,
      creator: { handle: creator?.handle ?? "unknown", displayName: creator?.displayName ?? "Unknown", level: creator?.level ?? 0 },
      milestones: ms,
      pointValueNow: pointValueForStage(project.stage),
      heldEscrowCents: Number(held[0]?.cents ?? 0),
      backers: invs.map((i) => ({ ...i.investment, handle: i.member.handle, displayName: i.member.displayName })),
      comments: cmts.map((c) => ({ ...c.comment, handle: c.member.handle, displayName: c.member.displayName, level: c.member.level })),
      equityBook: equity,
      viewer: {
        signedIn: !!viewerId,
        isOwner: viewerId === project.creatorId,
        investedCents: mine.reduce((s, p) => s + p.investment.amountCents, 0),
        equityBp: viewerBp,
        points: mine.reduce((s, p) => s + p.investment.pointsAwarded, 0),
      },
    };
  }),

  /**
   * Pitch anything legal, in one transaction: risk-scaled listing fee (house + reserve, booked once),
   * the $200 escrow retainer (vendor pass-through, not revenue), the project, its five milestones,
   * and the creator's 10,000 bp opening position.
   */
  pitch: memberProc
    .input(
      z.object({
        title: z.string().trim().min(3).max(80),
        tagline: z.string().trim().min(8).max(140),
        description: z.string().trim().min(40).max(4000),
        brand: brandEnum.default("forge"),
        category: z.string().max(40).default("other"),
        riskTier: riskEnum,
        capitalGoalCents: z.number().int().min(10000).max(100000000),
        pitchFormat: z.enum(["video", "deck", "drawing", "prototype", "writeup"]),
        pitchUrl: z.string().url().optional(),
        equityOfferedBp: z.number().int().min(100).max(5000).default(1000),
        acceptTerms: z.literal(true),
        idempotencyKey,
      }),
    )
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "projects.pitch", undefined, () =>
        once({ memberId: context.member.id, scope: "projects.pitch", key, payload }, async (tx) => {
          const member = context.member;
          const fee = pitchFeeCents(input.capitalGoalCents, input.riskTier);
          const vendor = ESCROW_VENDORS[Math.floor(Math.random() * ESCROW_VENDORS.length)];

          const [project] = await tx
            .insert(schema.projects)
            .values({
              creatorId: member.id,
              title: input.title,
              tagline: input.tagline,
              description: input.description,
              brand: input.brand,
              category: input.category,
              riskTier: input.riskTier,
              capitalGoalCents: input.capitalGoalCents,
              pitchFeeCents: fee,
              pitchFormat: input.pitchFormat,
              pitchUrl: input.pitchUrl ?? null,
              equityOfferedBp: input.equityOfferedBp,
              escrowVendor: vendor,
              escrowFeeCents: ESCROW_FEE_CENTS,
              escrowStatus: "assigned",
              status: "live",
              stage: 1,
            })
            .returning();

          await chargeService(tx, { kind: "pitch_fee", amountCents: fee, memberId: member.id, projectId: project.id, note: `Pitch listing fee (${input.riskTier} risk, ${usd(input.capitalGoalCents)} goal)` });
          await debit(tx, member.id, ESCROW_FEE_CENTS, "escrow retainer", project.id);
          await addLedger(tx, { kind: "escrow_retainer", amountCents: ESCROW_FEE_CENTS, memberId: member.id, projectId: project.id, bucket: "vendor", note: `Escrow retainer passed through to ${vendor} (simulated)` });
          await openCreatorPosition(tx, project.id, member.id);
          await tx.insert(schema.milestones).values(
            MILESTONE_TEMPLATES.map((m, i) => ({
              projectId: project.id,
              stage: i + 1,
              title: m.title,
              requirement: m.requirement,
              pointValue: pointValueForStage(i + 1),
              status: i === 0 ? "open" : "locked",
              dueAt: daysFromNow(30 * (i + 1)),
            })),
          );
          await addNotice(tx, {
            memberId: member.id,
            projectId: project.id,
            kind: "grace",
            title: "Project live — Stage 1 open, 30 days to first evidence",
            body: `${vendor} holds backer funds. Post your Stage 1 evidence before the due date; an independent reviewer verifies it, releases that stage's tickets and doubles the point value for the next round.`,
            recoveryPath: `Miss the date and you get a ${GRACE_DAYS}-day grace period plus a written cure plan before anything is foreclosed. Inactivity triggers default, not difficulty.`,
            dueAt: daysFromNow(30),
          });
          if (member.role === "member") await tx.update(schema.members).set({ role: "creator" }).where(eq(schema.members.id, member.id));
          await audit(tx, actorOf(context), { action: "projects.pitch", outcome: "accepted", targetType: "project", targetId: project.id, summary: `Pitched "${project.title}" — fee ${fee} + retainer ${ESCROW_FEE_CENTS} cents` });
          logDecision("pitch", "Project listed", { projectId: project.id, fee, retainer: ESCROW_FEE_CENTS });
          return project;
        }),
      );
    }),

  comment: memberProc
    .input(z.object({ projectId: z.number().int(), body: z.string().trim().min(2).max(1200), verdict: z.enum(["neutral", "try", "bye"]).default("neutral") }))
    .handler(({ input, context }) =>
      runTx("projects.comment", async (tx) => {
        await lockProject(tx, input.projectId);
        const [recent] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(schema.comments)
          .where(and(eq(schema.comments.memberId, context.member.id), sql`${schema.comments.createdAt} > ${Math.floor(Date.now() / 1000) - 60}`));
        if (Number(recent?.n ?? 0) >= 5) throw new ORPCError("TOO_MANY_REQUESTS", { message: "Five comments a minute is the limit. Breathe." });
        const [comment] = await tx.insert(schema.comments).values({ projectId: input.projectId, memberId: context.member.id, body: input.body, verdict: input.verdict }).returning();
        await tx.update(schema.members).set({ clout: sql`${schema.members.clout} + 2` }).where(eq(schema.members.id, context.member.id));
        logDecision("comments", "Posted", { memberId: context.member.id, projectId: input.projectId, verdict: input.verdict });
        return comment;
      }),
    ),

  /** Creator posts evidence for the open milestone; an administrator other than the creator reviews it. */
  submitMilestone: memberProc
    .input(z.object({ milestoneId: z.number().int(), evidence: z.string().trim().min(10).max(2000) }))
    .handler(({ input, context }) =>
      audited(actorOf(context), "projects.submitMilestone", { type: "milestone", id: input.milestoneId }, () =>
        runTx("projects.submitMilestone", async (tx) => {
          const [ms] = await tx.select().from(schema.milestones).where(eq(schema.milestones.id, input.milestoneId));
          if (!ms) throw new ORPCError("NOT_FOUND", { message: "Milestone not found" });
          const project = await lockProject(tx, ms.projectId);
          if (project.creatorId !== context.member.id) throw new ORPCError("FORBIDDEN", { message: "Only the project owner can submit evidence" });
          if (CLOSED.includes(project.status)) throw new ORPCError("BAD_REQUEST", { message: "This project is closed out" });
          if (ms.stage !== project.stage) throw new ORPCError("BAD_REQUEST", { message: `Only the current stage (${project.stage}) takes evidence` });
          const [updated] = await tx
            .update(schema.milestones)
            .set({ status: "submitted", evidence: input.evidence, submittedAt: new Date(), reviewerId: null, reviewedAt: null })
            .where(and(eq(schema.milestones.id, ms.id), eq(schema.milestones.status, "open")))
            .returning();
          if (!updated) throw new ORPCError("CONFLICT", { message: ms.status === "submitted" ? "Evidence is already waiting for review" : "This milestone is not open for evidence" });
          await tx
            .update(schema.projects)
            .set({ lastActivityAt: new Date(), status: project.status === "default_notice" ? "live" : project.status })
            .where(eq(schema.projects.id, project.id));
          await audit(tx, actorOf(context), { action: "projects.submitMilestone", outcome: "accepted", targetType: "milestone", targetId: ms.id, summary: `Stage ${ms.stage} evidence submitted` });
          return { ok: true, message: "Evidence logged. An independent reviewer will verify it before any held tickets release." };
        }),
      ),
    ),

  /** Creator cancels: only what is still held is settled — 75% back to backers, 25% retained. */
  cancel: memberProc
    .input(z.object({ projectId: z.number().int(), reason: z.string().trim().min(5).max(500), idempotencyKey }))
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "projects.cancel", { type: "project", id: input.projectId }, () =>
        once({ memberId: context.member.id, scope: "projects.cancel", key, payload }, async (tx) => {
          const project = await lockProject(tx, input.projectId);
          if (project.creatorId !== context.member.id) throw new ORPCError("FORBIDDEN", { message: "Only the project owner can cancel" });
          const [closed] = await tx
            .update(schema.projects)
            .set({ status: "cancelled", defaultReason: input.reason, escrowStatus: "settled" })
            .where(and(eq(schema.projects.id, project.id), notInArray(schema.projects.status, CLOSED)))
            .returning();
          if (!closed) throw new ORPCError("BAD_REQUEST", { message: "Project is already closed out" });
          const settled = await refundOnCancel(tx, project);
          await tx.update(schema.equityListings).set({ status: "cancelled" }).where(and(eq(schema.equityListings.projectId, project.id), eq(schema.equityListings.status, "open")));
          await tx.update(schema.milestones).set({ status: "failed" }).where(and(eq(schema.milestones.projectId, project.id), inArray(schema.milestones.status, ["open", "locked", "submitted"])));
          await addNotice(tx, {
            memberId: project.creatorId,
            projectId: project.id,
            kind: "cure_plan",
            title: "Cancellation settled — how to come back",
            body: `${usd(settled.refundedCents)} returned to backers and ${usd(settled.clawbackCents)} retained under the 25% clawback, from escrow still held. Released stages are not reversed.`,
            recoveryPath: "Two approved clout tasks or one verified milestone on a new project restores your standing. No permanent bans for cancelling honestly.",
          });
          await audit(tx, actorOf(context), { action: "projects.cancel", outcome: "accepted", targetType: "project", targetId: project.id, summary: `Refunded ${settled.refundedCents}, retained ${settled.clawbackCents}` });
          return settled;
        }),
      );
    }),

  /** Projects the signed-in creator runs, with their milestones and open notices. */
  mine: memberProc.handler(async ({ context }) => {
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.creatorId, context.member.id)).orderBy(desc(schema.projects.createdAt));
    const ids = rows.map((r) => r.id);
    const [ms, notices, held] = await Promise.all([
      ids.length ? db.select().from(schema.milestones).where(inArray(schema.milestones.projectId, ids)) : Promise.resolve([]),
      db
        .select()
        .from(schema.notices)
        .where(and(eq(schema.notices.memberId, context.member.id), eq(schema.notices.resolved, false)))
        .orderBy(desc(schema.notices.createdAt)),
      ids.length
        ? db
            .select({ projectId: schema.investments.projectId, cents: sql<number>`coalesce(sum(${schema.investments.heldCents}), 0)` })
            .from(schema.investments)
            .where(inArray(schema.investments.projectId, ids))
            .groupBy(schema.investments.projectId)
        : Promise.resolve([] as { projectId: number; cents: number }[]),
    ]);
    return rows.map((p) => ({
      ...p,
      heldEscrowCents: Number(held.find((h) => h.projectId === p.id)?.cents ?? 0),
      milestones: ms.filter((m) => m.projectId === p.id).sort((a, b) => a.stage - b.stage),
      notices: notices.filter((n) => n.projectId === p.id),
    }));
  }),
};
