import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const installations = pgTable(
  "installations",
  {
    id: serial("id").primaryKey(),
    githubInstallId: integer("github_install_id").notNull().unique(),
    accountLogin: varchar("account_login", { length: 255 }).notNull(),
    accountType: varchar("account_type", { length: 20 }).notNull(),
    accountId: integer("account_id").notNull(),
    planSlug: varchar("plan_slug", { length: 100 }).notNull().default("free"),
    planName: varchar("plan_name", { length: 255 }).notNull().default("Free"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    installedAt: timestamp("installed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_installations_account").on(table.accountLogin),
    index("idx_installations_status").on(table.status),
  ]
);

export const usagePeriods = pgTable(
  "usage_periods",
  {
    id: serial("id").primaryKey(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => installations.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    reviewsUsed: integer("reviews_used").notNull().default(0),
    reviewsLimit: integer("reviews_limit").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_usage_period_unique").on(
      table.installationId,
      table.periodStart
    ),
    index("idx_usage_installation").on(table.installationId),
  ]
);

export const reviewEvents = pgTable(
  "review_events",
  {
    id: serial("id").primaryKey(),
    installationId: integer("installation_id")
      .notNull()
      .references(() => installations.id),
    repoFullName: varchar("repo_full_name", { length: 500 }).notNull(),
    prNumber: integer("pr_number").notNull(),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}),
  },
  (table) => [
    index("idx_review_events_install").on(table.installationId),
    index("idx_review_events_repo").on(table.repoFullName, table.prNumber),
  ]
);

export const marketplaceEvents = pgTable("marketplace_events", {
  id: serial("id").primaryKey(),
  action: varchar("action", { length: 100 }).notNull(),
  githubAccountId: integer("github_account_id"),
  marketplacePlan: jsonb("marketplace_plan"),
  rawPayload: jsonb("raw_payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Installation = typeof installations.$inferSelect;
export type NewInstallation = typeof installations.$inferInsert;
export type UsagePeriod = typeof usagePeriods.$inferSelect;
export type ReviewEvent = typeof reviewEvents.$inferSelect;
export type MarketplaceEvent = typeof marketplaceEvents.$inferSelect;
