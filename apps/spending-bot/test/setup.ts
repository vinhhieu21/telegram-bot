import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { commandMenuState } from "../src/commands/menu";
import { setBotState } from "../src/db";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // The command menu counts as registered, so tests see only the Telegram calls they cause.
  // test/menu.test.ts clears this to test the registration itself.
  await setBotState(env.DB, "command_menu", commandMenuState(Number(env.ALLOWED_CHAT_ID)), new Date(0).toISOString());
});
