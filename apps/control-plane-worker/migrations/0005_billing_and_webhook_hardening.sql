CREATE TABLE tinkerbot_webhook_events_v2 (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (provider, event_id)
);

INSERT INTO tinkerbot_webhook_events_v2 (provider, event_id, status, received_at, processed_at)
SELECT provider, event_id, status, received_at, processed_at
FROM tinkerbot_webhook_events;

DROP TABLE tinkerbot_webhook_events;
ALTER TABLE tinkerbot_webhook_events_v2 RENAME TO tinkerbot_webhook_events;

CREATE TABLE tinkerbot_billing_accounts (
  organization_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan_id TEXT NOT NULL DEFAULT 'free',
  billing_interval TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  current_period_end TEXT,
  last_event_id TEXT,
  last_event_created_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_tinkerbot_billing_customer ON tinkerbot_billing_accounts (stripe_customer_id);
CREATE INDEX idx_tinkerbot_billing_subscription ON tinkerbot_billing_accounts (stripe_subscription_id);
