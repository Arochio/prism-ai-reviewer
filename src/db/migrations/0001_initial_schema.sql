CREATE TABLE IF NOT EXISTS installations (
  id                SERIAL PRIMARY KEY,
  github_install_id INTEGER NOT NULL UNIQUE,
  account_login     VARCHAR(255) NOT NULL,
  account_type      VARCHAR(20) NOT NULL,
  account_id        INTEGER NOT NULL,
  plan_slug         VARCHAR(100) NOT NULL DEFAULT 'free',
  plan_name         VARCHAR(255) NOT NULL DEFAULT 'Free',
  status            VARCHAR(20) NOT NULL DEFAULT 'active',
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at      TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  settings          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_installations_account ON installations(account_login);
CREATE INDEX IF NOT EXISTS idx_installations_status ON installations(status);

CREATE TABLE IF NOT EXISTS usage_periods (
  id               SERIAL PRIMARY KEY,
  installation_id  INTEGER NOT NULL REFERENCES installations(id),
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  reviews_used     INTEGER NOT NULL DEFAULT 0,
  reviews_limit    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(installation_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_installation ON usage_periods(installation_id, period_start);

CREATE TABLE IF NOT EXISTS review_events (
  id               SERIAL PRIMARY KEY,
  installation_id  INTEGER NOT NULL REFERENCES installations(id),
  repo_full_name   VARCHAR(500) NOT NULL,
  pr_number        INTEGER NOT NULL,
  event_type       VARCHAR(50) NOT NULL,
  status           VARCHAR(20) NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  metadata         JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_review_events_install ON review_events(installation_id);
CREATE INDEX IF NOT EXISTS idx_review_events_repo ON review_events(repo_full_name, pr_number);

CREATE TABLE IF NOT EXISTS marketplace_events (
  id                SERIAL PRIMARY KEY,
  action            VARCHAR(100) NOT NULL,
  github_account_id INTEGER,
  marketplace_plan  JSONB,
  raw_payload       JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
