import { z } from "zod";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { actorOf, adminProc, memberProc, publicProc } from "../middleware/auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { daysFromNow, houseFeeCents } from "../lib/economy";
import { audit, audited } from "../lib/services/audit";
import { releaseStage } from "../lib/services/escrow";
import { TOTAL_BP } from "../lib/services/equity";
import { idempotencyKey, isUniqueViolation, once } from "../lib/services/idempotency";
import { addLedger, bookFee } from "../lib/services/ledger";
import { addNotice } from "../lib/services/notices";
import { lockProject } from "../lib/services/tickets";
import { runTx, type Db } from "../lib/services/tx";
import { credit, usd } from "../lib/services/wallet";

const CLOSED = ["foreclosed", "cancelled", "redistributed", "closed"];

/**
 * One income-share run, inside the caller's transaction. Ownership comes from equity_positions
 * (after every primary ticket and secondary trade). The house takes 10% of gross, split
 * house/reserve once; each non-creator holder gets floor(net × bp / 10,000); the creator keeps
 * the remainder, so cents are conserved. The unique (project, period) index makes a second run
 * for the same period impossible even under a race.
 */
export async function runDistribution(tx: Db, args: { projectId: number; grossCents: number; period: string; note?: string }) {
  const project = await lockProject(tx, args.projectId);
  const holders = (
    await tx
      .select()
      .from(schema.equityPositions)
      .where(and(eq(schema.equityPositions.projectId, project.id), gt(schema.equityPositions.equityBp, 0)))
  ).filter((h) => h.memberId !== project.creatorId);
  const crowdBp = holders.reduce((s, h) => s + h.equityBp, 0);
  if (crowdBp > TOTAL_BP) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Ownership exceeds 100% — distribution halted for reconciliation" });

  const house = houseFeeCents(args.grossCents);
  const net = args.grossCents - house;
  const [row] = await tx
    .insert(schema.distributions)
    .values({ projectId: project.id, period: args.period, grossCents: args.grossCents, houseCents: house, holdersCents: 0, creatorCents: 0, holderCount: holders.length, crowdBp, note: args.note ?? null })
    .returning();

  let paid = 0;
  for (const h of holders) {
    const share = Math.floor((net * h.equityBp) / TOTAL_BP);
    if (share <= 0) continue;
    paid += share;
    await credit(tx, h.memberId, share, `${args.period} income share`, project.id);
    await addLedger(tx, { kind: "income_share", amountCents: share, memberId: h.memberId, projectId: project.id, bucket: "member", note: `${args.period} income share — ${(h.equityBp / 100).toFixed(2)}% of ${project.title}` });
  }
  const creatorCents = net - paid;
  await credit(tx, project.creatorId, creatorCents, `${args.period} creator share`, project.id);
  await addLedger(tx, { kind: "income_share", amountCents: creatorCents, memberId: project.creatorId, projectId: project.id, bucket: "creator", note: `${args.period} creator retained share of ${project.title}` });
  await bookFee(tx, { kind: "house_fee", feeCents: house, memberId: project.creatorId, projectId: project.id, note: `Income distribution ${args.period}` });
  const [final] = await tx
    .update(schema.distributions)
    .set({ holdersCents: paid, creatorCents })
    .where(eq(schema.distributions.id, row.id))
    .returning();
  await tx.update(schema.projects).set({ lastActivityAt: new Date() }).where(eq(schema.projects.id, project.id));
  logDecision("income", "Distribution partition", { projectId: project.id, period: args.period, gross: args.grossCents, house, paid, creatorCents, holders: holders.length });
  return final;
}

/** Implied value per bp from the most recent evidence available, with the method stated. */
async function markFor(project: typeof schema.projects.$inferSelect) {
  const [lastTrade] = await db
    .select()
    .from(schema.equityListings)
    .where(and(eq(schema.equityListings.projectId, project.id), eq(schema.equityListings.status, "filled")))
    .orderBy(desc(schema.equityListings.filledAt))
    .limit(1);
  if (lastTrade && lastTrade.equityBp > 0) return { centsPerBp: lastTrade.askCents / lastTrade.equityBp, method: "last secondary trade" };
  if (project.equityAllocatedBp > 0) return { centsPerBp: project.raisedCents / project.equityAllocatedBp, method: "round price paid" };
  return { centsPerBp: 0, method: "no price yet" };
}

export const payouts = {
  /** Creator reports simulated revenue for a period; holders are paid pro-rata from positions. */
  report: memberProc
    .input(
      z.object({
        projectId: z.number().int(),
        grossCents: z.number().int().min(100).max(10_000_000),
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
        note: z.string().trim().max(500).optional(),
        idempotencyKey,
      }),
    )
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "payouts.report", { type: "project", id: input.projectId }, async () => {
        const current = new Date().toISOString().slice(0, 7);
        if (input.period > current) throw new ORPCError("BAD_REQUEST", { message: "You cannot distribute revenue for a future period" });
        try {
          return await once({ memberId: context.member.id, scope: "payouts.report", key, payload }, async (tx) => {
            const project = await lockProject(tx, input.projectId);
            if (project.creatorId !== context.member.id) throw new ORPCError("FORBIDDEN", { message: "Only the project owner reports revenue" });
            if (CLOSED.includes(project.status)) throw new ORPCError("BAD_REQUEST", { message: "Closed projects do not distribute" });
            const run = await runDistribution(tx, { projectId: project.id, grossCents: input.grossCents, period: input.period, note: input.note });
            await audit(tx, actorOf(context), { action: "payouts.report", outcome: "accepted", targetType: "project", targetId: project.id, summary: `${input.period}: gross ${input.grossCents}, holders ${run.holdersCents}` });
            return run;
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw new ORPCError("CONFLICT", { message: `${input.period} has already been distributed` });
          throw error;
        }
      });
    }),

  /** Every run on a project — public, so backers can check the math. */
  history: publicProc.input(z.object({ projectId: z.number().int() })).handler(({ input }) =>
    db.select().from(schema.distributions).where(eq(schema.distributions.projectId, input.projectId)).orderBy(desc(schema.distributions.createdAt)),
  ),

  /** The signed-in member's positions: ownership from equity_positions, cost, income and an honest mark. */
  portfolio: memberProc.handler(async ({ context }) => {
    const memberId = context.member.id;
    const rows = await db
      .select({ position: schema.equityPositions, project: schema.projects })
      .from(schema.equityPositions)
      .innerJoin(schema.projects, eq(schema.equityPositions.projectId, schema.projects.id))
      .where(and(eq(schema.equityPositions.memberId, memberId), gt(schema.equityPositions.equityBp, 0), sql`${schema.projects.creatorId} <> ${memberId}`));
    const tickets = await db.select().from(schema.investments).where(and(eq(schema.investments.memberId, memberId), eq(schema.investments.kind, "primary")));
    const projectIds = [...new Set([...rows.map((r) => r.project.id), ...tickets.map((t) => t.projectId)])];
    if (!projectIds.length) {
      return { positions: [], totals: { costCents: 0, incomeCents: 0, markCents: 0, equityBp: 0, heldCents: 0 }, disclaimer: "No positions yet." };
    }
    const [income, extraProjects] = await Promise.all([
      db.select().from(schema.ledger).where(and(eq(schema.ledger.memberId, memberId), eq(schema.ledger.kind, "income_share"))),
      db.select().from(schema.projects).where(inArray(schema.projects.id, projectIds)),
    ]);

    const positions = [];
    for (const p of extraProjects) {
      if (p.creatorId === memberId) continue;
      const pos = rows.find((r) => r.project.id === p.id)?.position;
      const mine = tickets.filter((t) => t.projectId === p.id);
      const equityBp = pos?.equityBp ?? 0;
      const mark = await markFor(p);
      positions.push({
        projectId: p.id,
        title: p.title,
        brand: p.brand,
        status: p.status,
        stage: p.stage,
        equityBp,
        costCents: pos?.costCents ?? 0,
        ticketCents: mine.reduce((s, t) => s + t.amountCents, 0),
        heldCents: mine.reduce((s, t) => s + t.heldCents, 0),
        incomeCents: income.filter((l) => l.projectId === p.id).reduce((s, l) => s + l.amountCents, 0),
        markCents: CLOSED.includes(p.status) ? 0 : Math.round(equityBp * mark.centsPerBp),
        markMethod: CLOSED.includes(p.status) ? "closed — see notices" : mark.method,
      });
    }
    positions.sort((a, b) => b.costCents - a.costCents);
    return {
      positions,
      totals: {
        costCents: positions.reduce((s, p) => s + p.costCents, 0),
        incomeCents: positions.reduce((s, p) => s + p.incomeCents, 0),
        markCents: positions.reduce((s, p) => s + p.markCents, 0),
        equityBp: positions.reduce((s, p) => s + p.equityBp, 0),
        heldCents: positions.reduce((s, p) => s + p.heldCents, 0),
      },
      disclaimer: "Marks are estimates from the last trade or round price. They are not offers, not appraisals, and nobody is obliged to buy at them.",
    };
  }),
};

/** Escrow reviewer desk: verify milestone evidence once, release that stage's held tickets, advance the stage. */
export const escrow = {
  queue: adminProc.handler(async ({ context }) => {
    const rows = await db
      .select({ milestone: schema.milestones, project: schema.projects, creator: { handle: schema.members.handle } })
      .from(schema.milestones)
      .innerJoin(schema.projects, eq(schema.milestones.projectId, schema.projects.id))
      .innerJoin(schema.members, eq(schema.projects.creatorId, schema.members.id))
      .where(eq(schema.milestones.status, "submitted"))
      .orderBy(schema.milestones.submittedAt);
    const out = [];
    for (const r of rows) {
      const [held] = await db
        .select({ cents: sql<number>`coalesce(sum(${schema.investments.heldCents}), 0)`, n: sql<number>`count(*)` })
        .from(schema.investments)
        .where(and(eq(schema.investments.projectId, r.project.id), eq(schema.investments.stage, r.milestone.stage), gt(schema.investments.heldCents, 0)));
      out.push({
        ...r.milestone,
        projectTitle: r.project.title,
        creatorHandle: r.creator.handle,
        escrowVendor: r.project.escrowVendor,
        raisedCents: r.project.raisedCents,
        stageHeldCents: Number(held?.cents ?? 0),
        stageHeldTickets: Number(held?.n ?? 0),
        ownProject: r.project.creatorId === context.member.id,
      });
    }
    return out;
  }),

  review: adminProc
    .input(z.object({ milestoneId: z.number().int(), approve: z.boolean(), note: z.string().trim().min(5).max(800) }))
    .handler(({ input, context }) =>
      audited(actorOf(context), "escrow.review", { type: "milestone", id: input.milestoneId }, () =>
        runTx("escrow.review", async (tx) => {
          const [ms] = await tx.select().from(schema.milestones).where(eq(schema.milestones.id, input.milestoneId));
          if (!ms) throw new ORPCError("NOT_FOUND", { message: "Milestone not found" });
          const project = await lockProject(tx, ms.projectId);
          if (project.creatorId === context.member.id) {
            throw new ORPCError("FORBIDDEN", { message: "You cannot review evidence on your own project. Another administrator has to." });
          }
          const [claimed] = await tx
            .update(schema.milestones)
            .set({
              status: input.approve ? "verified" : "open",
              verifiedAt: input.approve ? new Date() : null,
              reviewerId: context.member.id,
              reviewedAt: new Date(),
              reviewNote: input.note,
            })
            .where(and(eq(schema.milestones.id, ms.id), eq(schema.milestones.status, "submitted")))
            .returning();
          if (!claimed) throw new ORPCError("CONFLICT", { message: "That evidence was already reviewed" });
          logDecision("escrow", "Evidence reviewed", { milestoneId: ms.id, approve: input.approve, reviewer: context.member.id });

          if (!input.approve) {
            await addNotice(tx, {
              memberId: project.creatorId,
              projectId: project.id,
              kind: "cure_plan",
              title: `${ms.title}: evidence needs another pass`,
              body: `Reviewer note: ${input.note}`,
              recoveryPath: "Nothing is penalised and no held ticket moves. Resubmit in your studio when ready.",
              dueAt: daysFromNow(21),
            });
            await audit(tx, actorOf(context), { action: "escrow.review", outcome: "accepted", targetType: "milestone", targetId: ms.id, summary: `Stage ${ms.stage} sent back` });
            return { approved: false, releasedCents: 0, stage: project.stage };
          }

          const released = await releaseStage(tx, project, ms.stage);
          const finalStage = ms.stage >= 5;
          const nextStage = finalStage ? 5 : ms.stage + 1;
          const [advanced] = await tx
            .update(schema.projects)
            .set({ stage: nextStage, status: finalStage ? "funded" : project.status === "default_notice" ? "live" : project.status, lastActivityAt: new Date() })
            .where(and(eq(schema.projects.id, project.id), eq(schema.projects.stage, ms.stage)))
            .returning();
          if (!advanced) throw new ORPCError("CONFLICT", { message: "The project moved stage while this was being reviewed" });
          if (!finalStage) {
            await tx
              .update(schema.milestones)
              .set({ status: "open", dueAt: daysFromNow(30) })
              .where(and(eq(schema.milestones.projectId, project.id), eq(schema.milestones.stage, nextStage), eq(schema.milestones.status, "locked")));
          }
          await tx.update(schema.members).set({ trustScore: sql`min(1000, ${schema.members.trustScore} + 12)` }).where(eq(schema.members.id, project.creatorId));
          await tx
            .update(schema.notices)
            .set({ resolved: true })
            .where(and(eq(schema.notices.projectId, project.id), eq(schema.notices.resolved, false), inArray(schema.notices.kind, ["default_notice", "grace"])));
          await addNotice(tx, {
            memberId: project.creatorId,
            projectId: project.id,
            kind: "reinstatement",
            title: `${ms.title} verified`,
            body: `${usd(released.releasedCents)} from ${released.tickets} stage-${ms.stage} tickets released from escrow (simulated). ${finalStage ? "All five stages done — the round is funded." : `Stage ${nextStage} is open; point value has doubled.`}`,
          });
          await audit(tx, actorOf(context), { action: "escrow.review", outcome: "accepted", targetType: "milestone", targetId: ms.id, summary: `Stage ${ms.stage} verified, released ${released.releasedCents}` });
          return { approved: true, releasedCents: released.releasedCents, stage: nextStage };
        }),
      ),
    ),
};
