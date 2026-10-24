import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { logDecision } from "../lib/log";
import { actorOf, adminProc, memberProc } from "../middleware/auth";
import { db } from "../database/client";
import * as schema from "../database/schema";
import { audit, audited } from "../lib/services/audit";
import { idempotencyKey, isUniqueViolation, once } from "../lib/services/idempotency";
import { addLedger } from "../lib/services/ledger";
import { addNotice } from "../lib/services/notices";
import { runTx } from "../lib/services/tx";
import { credit, usd } from "../lib/services/wallet";

/**
 * Simulated identity tiers. A member files a request; only an administrator can move
 * `members.kyc_status`. Nothing here checks a real document or a real accreditation.
 */
const RANK: Record<string, number> = { none: 0, pending: 0, verified: 1, accredited: 2 };

export const identity = {
  mine: memberProc.handler(async ({ context }) => {
    const requests = await db
      .select()
      .from(schema.identityRequests)
      .where(eq(schema.identityRequests.memberId, context.member.id))
      .orderBy(desc(schema.identityRequests.id))
      .limit(10);
    return { kycStatus: context.member.kycStatus, requests };
  }),

  request: memberProc
    .input(z.object({ tier: z.enum(["verified", "accredited"]), statement: z.string().trim().min(20).max(800) }))
    .handler(({ input, context }) =>
      audited(actorOf(context), "identity.request", undefined, async () => {
        if ((RANK[context.member.kycStatus] ?? 0) >= RANK[input.tier]) {
          throw new ORPCError("BAD_REQUEST", { message: `You already hold the ${context.member.kycStatus} tier` });
        }
        try {
          return await runTx("identity.request", async (tx) => {
            const [row] = await tx.insert(schema.identityRequests).values({ memberId: context.member.id, tier: input.tier, statement: input.statement }).returning();
            await audit(tx, actorOf(context), { action: "identity.request", outcome: "accepted", targetType: "identity_request", targetId: row.id, summary: `Requested ${input.tier} review` });
            return row;
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw new ORPCError("CONFLICT", { message: "You already have a review waiting with the house desk" });
          throw error;
        }
      }),
    ),

  queue: adminProc.handler(async () => {
    const rows = await db
      .select({ request: schema.identityRequests, member: schema.members })
      .from(schema.identityRequests)
      .innerJoin(schema.members, eq(schema.identityRequests.memberId, schema.members.id))
      .where(eq(schema.identityRequests.status, "pending"))
      .orderBy(schema.identityRequests.createdAt);
    return rows.map((r) => ({ ...r.request, handle: r.member.handle, displayName: r.member.displayName, currentStatus: r.member.kycStatus, level: r.member.level }));
  }),

  review: adminProc
    .input(z.object({ requestId: z.number().int(), decision: z.enum(["approve", "reject"]), note: z.string().trim().min(3).max(400) }))
    .handler(({ input, context }) =>
      audited(actorOf(context), "identity.review", { type: "identity_request", id: input.requestId }, () =>
        runTx("identity.review", async (tx) => {
          const [req] = await tx.select().from(schema.identityRequests).where(eq(schema.identityRequests.id, input.requestId));
          if (!req) throw new ORPCError("NOT_FOUND", { message: "No such request" });
          if (req.memberId === context.member.id) throw new ORPCError("FORBIDDEN", { message: "Administrators cannot review their own identity request" });
          const [claimed] = await tx
            .update(schema.identityRequests)
            .set({ status: input.decision === "approve" ? "approved" : "rejected", reviewerId: context.member.id, reviewNote: input.note, reviewedAt: new Date() })
            .where(and(eq(schema.identityRequests.id, req.id), eq(schema.identityRequests.status, "pending")))
            .returning();
          if (!claimed) throw new ORPCError("CONFLICT", { message: "That request was already reviewed" });
          if (input.decision === "approve") {
            await tx.update(schema.members).set({ kycStatus: req.tier }).where(eq(schema.members.id, req.memberId));
          }
          await addNotice(tx, {
            memberId: req.memberId,
            kind: input.decision === "approve" ? "reinstatement" : "cure_plan",
            title: input.decision === "approve" ? `Identity tier set to ${req.tier} (simulated)` : `Identity review not approved`,
            body: `${input.note} — this is a simulated review by the house desk, not a real identity or accreditation check.`,
            recoveryPath: input.decision === "approve" ? "Orbital Works and score lookups follow the accredited tier only." : "You keep full Level 0 access and can file a new request with more context.",
          });
          await audit(tx, actorOf(context), { action: "identity.review", outcome: "accepted", targetType: "member", targetId: req.memberId, summary: `${input.decision} ${req.tier}` });
          logDecision("identity", "Review recorded", { requestId: req.id, decision: input.decision, tier: req.tier });
          return claimed;
        }),
      ),
    ),

  /** Admin-only simulated credit grant. Members cannot mint credit for themselves. */
  grantCredit: adminProc
    .input(z.object({ handle: z.string().trim().toLowerCase(), amountCents: z.number().int().min(100).max(100000), reason: z.string().trim().min(3).max(200), idempotencyKey }))
    .handler(({ input, context }) => {
      const { idempotencyKey: key, ...payload } = input;
      return audited(actorOf(context), "identity.grantCredit", { type: "handle", id: input.handle }, () =>
        once({ memberId: context.member.id, scope: "identity.grantCredit", key, payload }, async (tx) => {
          const [target] = await tx.select().from(schema.members).where(eq(schema.members.handle, input.handle));
          if (!target) throw new ORPCError("NOT_FOUND", { message: "No member with that handle" });
          const balance = await credit(tx, target.id, input.amountCents, `admin grant: ${input.reason}`);
          await addLedger(tx, { kind: "admin_grant", amountCents: input.amountCents, memberId: target.id, bucket: "member", note: `Simulated credit grant by @${context.member.handle}: ${input.reason}` });
          await addNotice(tx, { memberId: target.id, kind: "reinstatement", title: `${usd(input.amountCents)} simulated credit added`, body: `The house desk added simulated club credit: ${input.reason}. No card or bank was involved.` });
          await audit(tx, actorOf(context), { action: "identity.grantCredit", outcome: "accepted", targetType: "member", targetId: target.id, summary: `Granted ${input.amountCents} cents` });
          return { memberId: target.id, handle: target.handle, balanceCents: balance };
        }),
      );
    }),
};
