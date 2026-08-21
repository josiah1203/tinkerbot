-- Factory definition tree (agents, automations, runners) stored beside factory.yaml.

ALTER TABLE tinkerbot_factory_definitions ADD COLUMN files_json TEXT;
