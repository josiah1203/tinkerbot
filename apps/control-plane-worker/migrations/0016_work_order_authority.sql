-- Three-truth WorkOrder fields and cell capability columns.

ALTER TABLE tinkerbot_work_orders ADD COLUMN verification_verdict TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE tinkerbot_work_orders ADD COLUMN review_assessment TEXT NOT NULL DEFAULT 'NEEDS_HUMAN_REVIEW';
ALTER TABLE tinkerbot_work_orders ADD COLUMN release_decision TEXT NOT NULL DEFAULT 'BLOCKED';
ALTER TABLE tinkerbot_work_orders ADD COLUMN waiver_json TEXT;

ALTER TABLE tinkerbot_work_cells ADD COLUMN production_access TEXT NOT NULL DEFAULT 'denied';
ALTER TABLE tinkerbot_work_cells ADD COLUMN observability TEXT NOT NULL DEFAULT 'read-only';
ALTER TABLE tinkerbot_work_cells ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]';
