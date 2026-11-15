// One-off setup: registers the webhook.
//
//   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://spending-bot.<you>.workers.dev node scripts/setup-telegram.mjs
//
// The command menu is not set here: the Worker registers it itself (src/commands/menu.ts).

const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) {
  console.error("BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL are required");
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  console.log(`${method}: ok`);
}

await call("setWebhook", {
  url: WORKER_URL,
  secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "edited_message", "my_chat_member"],
  drop_pending_updates: true,
});

