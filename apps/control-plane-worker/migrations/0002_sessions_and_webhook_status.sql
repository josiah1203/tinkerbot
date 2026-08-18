CREATE TABLE IF NOT EXISTS tinkerbot_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email_verified INTEGER,
  organization_id TEXT,
  expires_at TEXT,
  authentication_method TEXT,
  token_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_sessions_user_id ON tinkerbot_sessions (user_id);

ALTER TABLE tinkerbot_webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'processed';
ALTER TABLE tinkerbot_webhook_events ADD COLUMN processed_at TEXT;
