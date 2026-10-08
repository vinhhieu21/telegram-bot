# Telegram Spending Bot (v1)

A Telegram bot for one friend group. Members log spending with `/add`, check totals with `/check` and `/summary`, and get an automatic monthly summary. A nightly recap is optional. It runs on one Cloudflare Worker with D1 storage and costs nothing on the free tiers.

| Command | Example | What it does |
|---|---|---|
| `/add <amount> [note] [hôm qua \| dd/mm]` | `/add 50k cafe sáng` | Saves an expense for the sender |
| `/check` | | Each member's total from the 1st of the month to today, plus today's group total |
| `/summary [month] [year]` | `/summary 9` | Full summary for one month, with the change vs. the previous month |
| `/undo` | | Soft-deletes the sender's most recent expense |
| `/daily on\|off` | | Turns the 21:00 ICT nightly recap on or off |
| `/help` | | Lists the commands |

Amounts: `50k`, `32.5k`, `1tr2` (1,200,000), `1.5tr`, `2m`, `1.250.000`, `50000`. A bare number under 1,000 is rejected. The valid range is 1,000đ to 100,000,000đ.

## Layout

```
wrangler.toml            D1 binding "DB", cron triggers, vars
migrations/0001_init.sql
src/
  index.ts               fetch() = webhook, scheduled() = cron
  router.ts              chat filter, /cmd@Bot stripping, dispatch
  telegram.ts            sendMessage / leaveChat over fetch
  db.ts                  all SQL
  time.ts                ICT (UTC+7) date helpers
  parse/{amount,date,add}.ts
  commands/*.ts
  report/format.ts       VND formatting, HTML escaping, message templates
  jobs/{daily,monthly}.ts
scripts/setup-telegram.mjs   setWebhook + setMyCommands
test/                    Vitest (unit + integration on local D1)
```

## Develop

```sh
npm install
npm test            # unit + integration (local D1, Telegram API mocked)
npm run typecheck
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.toml
```

## Deploy

1. Create the bot with @BotFather (`/newbot`). Leave `/setprivacy` **Enabled**.
2. `npx wrangler login`
3. `npx wrangler d1 create spending-bot-db`, then paste the `database_id` into `wrangler.toml`.
4. `npm run db:migrate:remote`
5. `npx wrangler secret put BOT_TOKEN` and `npx wrangler secret put WEBHOOK_SECRET` (use 32+ random characters, e.g. `openssl rand -hex 32`).
6. Set `BOT_USERNAME` in `wrangler.toml` (without the `@`). Leave `ALLOWED_CHAT_ID` empty for now.
7. `npm run deploy`
8. Register the webhook and command menu:
   ```sh
   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://spending-bot.<subdomain>.workers.dev npm run setup:telegram
   ```
9. Run `npx wrangler tail`, add the bot to the group, and send `/help`. The log prints the group's `chat_id`, which is a negative number.
10. Put that id in `ALLOWED_CHAT_ID` in `wrangler.toml` and run `npm run deploy` again. Re-run step 8 with `ALLOWED_CHAT_ID=...` to scope the command menu to the group.

Test this in a private group with two accounts before you add the bot to the real group.

## Behaviour notes

- Any request without the correct `X-Telegram-Bot-Api-Secret-Token` gets a 401. Once the secret is valid, the Worker always answers 200, so Telegram never retries and creates duplicates. Duplicate updates are also skipped through `processed_updates`, which the daily cron prunes after 7 days.
- Until `ALLOWED_CHAT_ID` is set, the bot only logs chat ids. After that it leaves every other group and answers DMs with a one-line notice.
- Cron schedules are in UTC: `0 14 * * *` is 21:00 ICT (the daily recap, sent only when it is on and there was spending today). `0 2 1 * *` is 09:00 ICT on the 1st (the monthly summary, always sent).
- Defaults chosen from the plan's open decisions: replies in Vietnamese, any member can run `/daily`, and `/undo` removes your last entry whatever its age.
