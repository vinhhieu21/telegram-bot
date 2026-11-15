-- migrations/0006_bot_state.sql
-- Small bot-wide facts kept between requests. For now only "command_menu": the command menu
-- last registered with Telegram, so the Worker re-registers it only when the code changes it.
CREATE TABLE bot_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL                 -- ISO 8601 UTC
);
