import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { usagePeriods } from "../db/schema";
import { getPlan } from "../config/plans";
import { logger } from "./logger";

// Returns the first day of the current UTC month (start of billing period).
const getPeriodStart = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

// Returns the first day of the next UTC month (exclusive end of billing period).
const getPeriodEnd = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
};

/**
 * Checks whether this installation is within its monthly review limit and,
 * if so, atomically increments the counter.
 *
 * Returns { allowed: true } or { allowed: false, reason: string }.
 * Always returns { allowed: true } when the DB is unavailable or the plan is unlimited,
 * so a DB outage never blocks reviews.
 *
 * @param dbInstallationId — the internal `installations.id` (not the GitHub install ID)
 * @param planSlug — current plan slug from the installations row
 */
export const checkAndIncrementUsage = async (
  dbInstallationId: number,
  planSlug: string,
): Promise<{ allowed: boolean; reason?: string }> => {
  const plan = getPlan(planSlug);

  // Unlimited plans skip the DB entirely.
  if (plan.reviewsPerMonth === 0) return { allowed: true };

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    logger.warn({ dbInstallationId }, "DB unavailable — skipping usage check");
    return { allowed: true };
  }

  const periodStart = getPeriodStart();
  const periodEnd = getPeriodEnd();

  // Ensure a row exists for the current period (no-op if already present).
  await db
    .insert(usagePeriods)
    .values({
      installationId: dbInstallationId,
      periodStart,
      periodEnd,
      reviewsUsed: 0,
      reviewsLimit: plan.reviewsPerMonth,
    })
    .onConflictDoNothing();

  // Atomically increment only if still under the limit.
  // Returning an empty array means the limit was already reached.
  const updated = await db
    .update(usagePeriods)
    .set({ reviewsUsed: sql`${usagePeriods.reviewsUsed} + 1` })
    .where(
      and(
        eq(usagePeriods.installationId, dbInstallationId),
        eq(usagePeriods.periodStart, periodStart),
        lt(usagePeriods.reviewsUsed, plan.reviewsPerMonth),
      ),
    )
    .returning({ reviewsUsed: usagePeriods.reviewsUsed });

  if (updated.length === 0) {
    logger.warn({ dbInstallationId, planSlug, limit: plan.reviewsPerMonth }, "Monthly review limit reached");
    return {
      allowed: false,
      reason: `Monthly review limit of ${plan.reviewsPerMonth} reached for the ${plan.name} plan.`,
    };
  }

  return { allowed: true };
};
