import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        // Workers AI has no local simulator; tests stub env.AI.run instead of calling Cloudflare.
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: "test-token",
            WEBHOOK_SECRET: "test-secret",
            ALLOWED_CHAT_ID: "-100123",
            BOT_USERNAME: "spending_test_bot",
            // Sheets sync is off unless a test turns it on (test/sheets.test.ts), and never sees the real key.
            GOOGLE_SHEET_ID: "",
            GOOGLE_SERVICE_ACCOUNT_KEY: "",
            ADMIN_USER_ID: "",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
