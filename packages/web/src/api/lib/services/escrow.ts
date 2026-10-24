import { and, eq, gt } from "drizzle-orm";
import * as schema from "../../database/schema";
import { CANCEL_CLAWBACK_RATE } from "../economy";
import { logDecision } from "../log";
import { addLedger } from "./ledger";
import { addNotice } from "./notices";
import type { Db } from "./tx";
import { credit, usd } from "./wallet";

/**
 * Simulated escrow. `investments.held_cents` is the only source of truth for what is still held;
 * `projects.raised_cents` is historical. Every settlement reads the held rows inside the caller's
 * transaction and zeroes them with a conditional update, so nothing can be paid out twice and
 * previously released capital is never touched again.
 */

type Project = typeof schema.projects.$inferSelect;

export async function heldTickets(tx: Db, projectId: number, stage?: number) {
  const conditions = [eq(schema.investments.projectId, projectId), eq(schema.investments.kind, "primary"), gt(schema.investments.heldCents, 0)];
  if (stage !== undefined) conditions.push(eq(schema.investments.stage, stage));
  return tx.select().from(schema.investments).where(and(...conditions));
}

/** Zeroes one ticket's held amount; returns the cents it held, or 0 if another settlement got there first. */
async function drain(tx: Db, investmentId: number, status: string) {
  const [row] = await tx
    .update(schema.investments)
    .set({ heldCents: 0, escrowStatus: status })
    .where(and(eq(schema.investments.id, investmentId), gt(schema.investments.heldCents, 0)))
    .returning({ id: schema.investments.id });
  return row ? 1 : 0;
}

async function escrowOut(tx: Db, project: Project, cents: number, kind: string, note: string) {
  if (cents <= 0) return;
  await addLedger(tx, { kind, amountCents: -cents, projectId: project.id, bucket: "escrow", note });
}

/** Milestone verified: tickets placed at that stage are released to the creator, once. */
export async function releaseStage(tx: Db, project: Project, stage: number) {
  const rows = await heldTickets(tx, project.id, stage);
  let released = 0;
  for (const row of rows) {
    if (await drain(tx, row.id, "released")) released += row.heldCents;
  }
  if (released > 0) {
    await credit(tx, project.creatorId, released, `stage ${stage} escrow release`, project.id);
    await escrowOut(tx, project, released, "escrow_release", `Stage ${stage} verified — ${rows.length} tickets released`);
    await addLedger(tx, { kind: "escrow_release", amountCents: released, memberId: project.creatorId, projectId: project.id, bucket: "creator", note: `Stage ${stage} tranche (simulated)` });
  }
  logDecision("escrow", "Stage released", { projectId: project.id, stage, tickets: rows.length, released });
  return { releasedCents: released, tickets: rows.length };
}

/** Creator cancellation: 75% of what is still held returns to each backer, 25% is retained. */
export async function refundOnCancel(tx: Db, project: Project) {
  const rows = await heldTickets(tx, project.id);
  let refunded = 0;
  let retained = 0;
  for (const row of rows) {
    if (!(await drain(tx, row.id, "refunded"))) continue;
    const back = Math.round(row.heldCents * (1 - CANCEL_CLAWBACK_RATE));
    refunded += back;
    retained += row.heldCents - back;
    await credit(tx, row.memberId, back, `cancellation refund on #${project.id}`, project.id);
    await addLedger(tx, { kind: "refund", amountCents: back, memberId: row.memberId, projectId: project.id, bucket: "member", note: "75% of held principal returned on creator cancellation" });
    await addNotice(tx, {
      memberId: row.memberId,
      projectId: project.id,
      kind: "reserve_claim",
      title: `${project.title} was cancelled by its creator`,
      body: `${usd(back)} of your held ${usd(row.heldCents)} came back to your simulated wallet. Funds already released at verified stages are not reversed.`,
      recoveryPath: "Your equity stays on record. The Mutual Cover Reserve can be petitioned through governance.",
    });
  }
  const houseCut = Math.round(retained * 0.4);
  if (retained > 0) {
    await addLedger(tx, { kind: "clawback", amountCents: houseCut, projectId: project.id, bucket: "house", note: "House share of cancellation clawback" });
    await addLedger(tx, { kind: "feature_funding", amountCents: retained - houseCut, projectId: project.id, bucket: "feature_fund", note: "Cancellation clawback routed to member-value features" });
  }
  await escrowOut(tx, project, refunded + retained, "escrow_settlement", "Held escrow settled on cancellation");
  logDecision("escrow", "Cancellation settled", { projectId: project.id, tickets: rows.length, refunded, retained });
  return { refundedCents: refunded, clawbackCents: retained, backers: new Set(rows.map((r) => r.memberId)).size };
}

/** Foreclosure: half of what is still held funds features; the rest returns pro-rata to holders of held tickets. */
export async function settleForeclosure(tx: Db, project: Project) {
  const rows = await heldTickets(tx, project.id);
  const total = rows.reduce((s, r) => s + r.heldCents, 0);
  const featureShare = Math.round(total * 0.5);
  const residual = total - featureShare;
  let paid = 0;
  const perMember = new Map<number, { share: number; held: number }>();
  rows.forEach((row, i) => {
    const share = i === rows.length - 1 ? residual - paid : Math.floor((residual * row.heldCents) / Math.max(1, total));
    paid += share;
    const prior = perMember.get(row.memberId) ?? { share: 0, held: 0 };
    perMember.set(row.memberId, { share: prior.share + share, held: prior.held + row.heldCents });
  });
  for (const row of rows) await drain(tx, row.id, "clawback_settled");
  for (const [memberId, v] of perMember) {
    await credit(tx, memberId, v.share, `foreclosure residual on #${project.id}`, project.id);
    await addLedger(tx, { kind: "redistribution", amountCents: v.share, memberId, projectId: project.id, bucket: "member", note: "Residual held escrow returned pro-rata on foreclosure" });
    await addNotice(tx, {
      memberId,
      projectId: project.id,
      kind: "reserve_claim",
      title: `Foreclosure settled on ${project.title}`,
      body: `${usd(v.share)} of the ${usd(v.held)} still held for you returned to your simulated wallet. Your equity is not cancelled by foreclosure.`,
      recoveryPath: "The foreclosure lot is on the Equity Book. If a member operator revives the project, your slice rides along.",
    });
  }
  if (featureShare > 0) {
    await addLedger(tx, { kind: "feature_funding", amountCents: featureShare, projectId: project.id, bucket: "feature_fund", note: "Foreclosed asset's held escrow routed to member-value features" });
  }
  await escrowOut(tx, project, total, "escrow_settlement", "Held escrow settled on foreclosure");
  logDecision("escrow", "Foreclosure settled", { projectId: project.id, total, featureShare, residual });
  return { heldCents: total, featureFundCents: featureShare, residualDistributedCents: residual, holders: perMember.size };
}
