import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../../database/schema";
import { MAX_INVEST_CENTS, equityBpForTicket, houseFeeCents, pointValueForStage } from "../economy";
import { logDecision } from "../log";
import type { Member } from "../../middleware/auth";
import { transferEquity } from "./equity";
import { addLedger, bookFee } from "./ledger";
import type { Db } from "./tx";
import { debit, usd } from "./wallet";

/** Simulated accreditation is an admin-approved status. Paid levels never substitute for it. */
export const isAccredited = (member: Pick<Member, "kycStatus">) => member.kycStatus === "accredited";

export async function lockProject(tx: Db, projectId: number) {
  const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found" });
  return project;
}

/**
 * A primary ticket, fully inside the caller's transaction:
 * wallet −amount → escrow (amount − 10% fee) + house/reserve split of the fee;
 * equity moves from the creator's position to the backer; points and clout are granted.
 */
export async function placeTicket(tx: Db, member: Member, projectId: number, amountCents: number, source: string) {
  if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > MAX_INVEST_CENTS) {
    throw new ORPCError("BAD_REQUEST", { message: "Tickets run $1 to $10 in whole cents" });
  }
  const project = await lockProject(tx, projectId);
  const [fresh] = await tx.select().from(schema.members).where(eq(schema.members.id, member.id));

  // "funded" means every stage is verified: a new ticket would have no stage left to release it.
  if (project.status !== "live") {
    throw new ORPCError("BAD_REQUEST", { message: project.status === "funded" ? "All five stages are verified — this round is closed to new tickets. Look for equity on the Equity Book." : "This round is not taking tickets" });
  }
  if (project.creatorId === fresh.id) {
    throw new ORPCError("BAD_REQUEST", { message: "You cannot back your own project" });
  }
  if (project.brand === "orbital" && !isAccredited(fresh)) {
    throw new ORPCError("FORBIDDEN", {
      message: "Orbital Works backing needs administrator-approved simulated accreditation. Paid levels are participation tiers, not accreditation.",
    });
  }
  if (project.stage > 1 && !fresh.ongoingAccess && fresh.level < 2) {
    throw new ORPCError("FORBIDDEN", {
      message: "Level 0 and 1 back new rounds only. Unlock ongoing rounds for $5, or reach Operator with points.",
    });
  }

  const [held] = await tx
    .select({ total: sql<number>`coalesce(sum(${schema.investments.amountCents}), 0)`, count: sql<number>`count(*)` })
    .from(schema.investments)
    .where(and(eq(schema.investments.memberId, fresh.id), eq(schema.investments.projectId, project.id), eq(schema.investments.kind, "primary")));
  const already = Number(held?.total ?? 0);
  logDecision("tickets", "Ceiling checked", { memberId: fresh.id, projectId: project.id, already, requested: amountCents });
  if (already + amountCents > MAX_INVEST_CENTS) {
    throw new ORPCError("BAD_REQUEST", { message: `You already hold ${usd(already)} here. The per-project ceiling is $10.` });
  }

  const fee = houseFeeCents(amountCents);
  const escrowed = amountCents - fee;
  const points = Math.round(pointValueForStage(project.stage) * (amountCents / MAX_INVEST_CENTS));
  const equityBp = equityBpForTicket(escrowed, project.capitalGoalCents, project.equityOfferedBp);
  if (project.equityAllocatedBp + equityBp > project.equityOfferedBp) {
    throw new ORPCError("BAD_REQUEST", { message: "The crowd slice for this round is fully allocated" });
  }

  await debit(tx, fresh.id, amountCents, `ticket on project #${project.id}`, project.id);
  await transferEquity(tx, { projectId: project.id, fromMemberId: project.creatorId, toMemberId: fresh.id, bp: equityBp, costCents: escrowed });

  const [investment] = await tx
    .insert(schema.investments)
    .values({
      projectId: project.id,
      memberId: fresh.id,
      amountCents,
      pointsAwarded: points,
      equityBp,
      stage: project.stage,
      houseFeeCents: fee,
      escrowStatus: "held",
      kind: "primary",
      heldCents: escrowed,
    })
    .returning();

  await tx
    .update(schema.projects)
    .set({
      raisedCents: sql`${schema.projects.raisedCents} + ${escrowed}`,
      backerCount: Number(held?.count ?? 0) > 0 ? project.backerCount : sql`${schema.projects.backerCount} + 1`,
      equityAllocatedBp: sql`${schema.projects.equityAllocatedBp} + ${equityBp}`,
      lastActivityAt: new Date(),
    })
    .where(eq(schema.projects.id, project.id));
  await tx
    .update(schema.members)
    .set({ points: sql`${schema.members.points} + ${points}`, clout: sql`${schema.members.clout} + 3` })
    .where(eq(schema.members.id, fresh.id));

  await addLedger(tx, {
    kind: "investment",
    amountCents: escrowed,
    memberId: fresh.id,
    projectId: project.id,
    bucket: "escrow",
    note: `Ticket held by ${project.escrowVendor ?? "assigned escrow agent"} (${source}, simulated)`,
  });
  await bookFee(tx, { kind: "house_fee", feeCents: fee, memberId: fresh.id, projectId: project.id, note: "Ticket" });

  return { investmentId: investment.id, projectId: project.id, pointsAwarded: points, equityBp, escrowedCents: escrowed, houseFeeCents: fee };
}
