import { eq } from "drizzle-orm";
import { getDb } from "../db/connection";
import {
  installations,
  marketplaceEvents,
  reviewEvents,
  type Installation,
} from "../db/schema";
import { logger } from "./logger";

export const upsertInstallation = async (params: {
  githubInstallId: number;
  accountLogin: string;
  accountType: string;
  accountId: number;
  planSlug?: string;
  planName?: string;
}): Promise<Installation> => {
  const db = getDb();
  const existing = await db
    .select()
    .from(installations)
    .where(eq(installations.githubInstallId, params.githubInstallId))
    .limit(1);

  if (existing.length > 0) {
    const [updated] = await db
      .update(installations)
      .set({
        accountLogin: params.accountLogin,
        accountType: params.accountType,
        accountId: params.accountId,
        status: "active",
        suspendedAt: null,
        deletedAt: null,
        ...(params.planSlug && { planSlug: params.planSlug }),
        ...(params.planName && { planName: params.planName }),
        updatedAt: new Date(),
      })
      .where(eq(installations.githubInstallId, params.githubInstallId))
      .returning();
    logger.info(
      { githubInstallId: params.githubInstallId },
      "Installation updated"
    );
    return updated;
  }

  const [created] = await db
    .insert(installations)
    .values({
      githubInstallId: params.githubInstallId,
      accountLogin: params.accountLogin,
      accountType: params.accountType,
      accountId: params.accountId,
      planSlug: params.planSlug ?? "free",
      planName: params.planName ?? "Free",
    })
    .returning();
  logger.info(
    { githubInstallId: params.githubInstallId },
    "Installation created"
  );
  return created;
};

export const getInstallationByGithubId = async (
  githubInstallId: number
): Promise<Installation | null> => {
  const db = getDb();
  const rows = await db
    .select()
    .from(installations)
    .where(eq(installations.githubInstallId, githubInstallId))
    .limit(1);
  return rows[0] ?? null;
};

export const suspendInstallation = async (
  githubInstallId: number
): Promise<void> => {
  const db = getDb();
  await db
    .update(installations)
    .set({ status: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
    .where(eq(installations.githubInstallId, githubInstallId));
  logger.info({ githubInstallId }, "Installation suspended");
};

export const unsuspendInstallation = async (
  githubInstallId: number
): Promise<void> => {
  const db = getDb();
  await db
    .update(installations)
    .set({ status: "active", suspendedAt: null, updatedAt: new Date() })
    .where(eq(installations.githubInstallId, githubInstallId));
  logger.info({ githubInstallId }, "Installation unsuspended");
};

export const deleteInstallation = async (
  githubInstallId: number
): Promise<void> => {
  const db = getDb();
  await db
    .update(installations)
    .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(installations.githubInstallId, githubInstallId));
  logger.info({ githubInstallId }, "Installation soft-deleted");
};

export const updateInstallationPlan = async (
  githubInstallId: number,
  planSlug: string,
  planName: string
): Promise<void> => {
  const db = getDb();
  await db
    .update(installations)
    .set({ planSlug, planName, updatedAt: new Date() })
    .where(eq(installations.githubInstallId, githubInstallId));
  logger.info({ githubInstallId, planSlug }, "Installation plan updated");
};

export const logMarketplaceEvent = async (
  action: string,
  githubAccountId: number | undefined,
  marketplacePlan: unknown,
  rawPayload: unknown
): Promise<void> => {
  const db = getDb();
  await db.insert(marketplaceEvents).values({
    action,
    githubAccountId: githubAccountId ?? null,
    marketplacePlan: marketplacePlan ?? null,
    rawPayload: rawPayload ?? {},
  });
};

export const createReviewEvent = async (
  installationId: number,
  repoFullName: string,
  prNumber: number,
  eventType: string
): Promise<number> => {
  const db = getDb();
  const [row] = await db
    .insert(reviewEvents)
    .values({
      installationId,
      repoFullName,
      prNumber,
      eventType,
      status: "started",
    })
    .returning({ id: reviewEvents.id });
  return row.id;
};

export const completeReviewEvent = async (
  eventId: number,
  status: "completed" | "failed" | "skipped_limit",
  metadata?: Record<string, unknown>
): Promise<void> => {
  const db = getDb();
  await db
    .update(reviewEvents)
    .set({
      status,
      completedAt: new Date(),
      ...(metadata && { metadata }),
    })
    .where(eq(reviewEvents.id, eventId));
};
