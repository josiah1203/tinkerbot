CREATE TABLE IF NOT EXISTS tinkerbot_invitations (
  invitation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  provider_invitation_id TEXT,
  inviter_user_id TEXT,
  accepted_user_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tinkerbot_invitations_organization ON tinkerbot_invitations (organization_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_tinkerbot_invitations_email ON tinkerbot_invitations (organization_id, email, state);
