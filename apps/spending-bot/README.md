# Telegram Spending Bot (v1)

A Telegram bot for one friend group.
Members log spending with `/add`, check their own totals with `/check` and `/summary` (or the whole group's with `/groupcheck` and `/groupsummary`), and get an automatic monthly summary.
A nightly recap is optional, and so is a Google Sheet with one tab per month.
`/app` opens a Telegram Mini App with charts of the group's spending.
It runs on one Cloudflare Worker with D1 storage and costs nothing on the free tiers.

| Command | Example | What it does |
|---|---|---|
| `/add <amount> [note] [hôm qua \| dd/mm]` | `/add 50k cafe sáng` | Saves an expense for the sender. Editing the message updates it |
| `/check` | | The sender's own total from the 1st of the month to today, plus their total for today |
| `/groupcheck` | | Each member's total from the 1st of the month to today, plus today's group total, plus what is left of the budget when one is set |
| `/budget [amount\|off]` | `/budget 5tr` | Sets the group's monthly budget, shows spent and remaining this month, or removes it |
| `/summary [month] [year]` | `/summary 9` | The sender's own summary for one month, with the change vs. the previous month and a breakdown by category |
| `/groupsummary [month] [year]` | `/groupsummary 9` | The same for the whole group, ranked by member |
| `/undo` | reply `/undo` to your `/add` | Soft-deletes the sender's most recent expense, or, sent as a reply to one of their own `/add` messages, that expense |
| `/daily on\|off` | | Turns the 21:00 ICT nightly recap on or off |
| `/app` | | A button that opens the Mini App (see below) |
| `/help` | | Lists the commands |

Amounts: `50k`, `32.5k`, `1tr2` (1,200,000), `1.5tr`, `2m`, `1.250.000`, `50000`.
A space before the unit also works, e.g. `50 nghìn`, `2 tr`, `1,5 triệu`.
A bare number under 1,000 is rejected.
The valid range is 1,000đ to 100,000,000đ.

## Layout

```
wrangler.toml            D1 binding "DB", cron triggers, vars
migrations/*.sql
src/
  index.ts               fetch(): POST = webhook, GET = Mini App; scheduled() = cron
  crons.ts               the cron schedules scheduled() dispatches on
  router.ts              chat filter, /cmd@Bot stripping, dispatch
  telegram.ts            sendMessage / leaveChat over fetch
  db.ts                  all SQL
  time.ts                ICT (UTC+7) date helpers
  parse/{amount,date,add}.ts
  commands/*.ts
  report/format.ts       VND formatting, HTML escaping, message templates
  jobs/{daily,monthly}.ts
  ai/llm.ts              Workers AI client (the only place that calls a model)
  ai/categories.ts       the fixed category list
  ai/categorize.ts       note -> category, cached per note in note_categories
  ai/commentary.ts       monthly commentary, checked against the SQL numbers
  sheets/google.ts       Google Sheets API client (service-account sign-in, retries)
  sheets/tab.ts          one month's expenses -> its tab's cells and layout
  sheets/sync.ts         which month tabs are behind, leases, failure alerts
  web/auth.ts            Mini App init data check (HMAC with the bot token)
  web/server.ts          GET /app/ (static page) and GET /api/month
  web/api.ts             the /api/month response type, shared with the page
web/                     the Mini App page: main.ts (no framework), style.css, index.html, _headers
scripts/build-web.mjs    web/ -> dist/web/, with content-hashed file names
scripts/setup-telegram.mjs   setWebhook
test/                    Vitest (unit + integration on local D1)
```

## Develop

```sh
npm install
npm test            # builds the page, then unit + integration (local D1, Telegram API mocked)
npm run typecheck   # the Worker and the page
npm run types       # regenerate worker-configuration.d.ts after editing wrangler.toml
```

## Deploy

1. Create the bot with @BotFather (`/newbot`). Leave `/setprivacy` **Enabled**.
2. `npx wrangler login`
3. `npx wrangler d1 create spending-bot-db`, then paste the `database_id` into `wrangler.toml`.
4. `npm run db:migrate:remote` (run it again after pulling new files in `migrations/`)
5. `npx wrangler secret put BOT_TOKEN` and `npx wrangler secret put WEBHOOK_SECRET` (use 32+ random characters, e.g. `openssl rand -hex 32`).
6. Set `BOT_USERNAME` in `wrangler.toml` (without the `@`). Leave `ALLOWED_CHAT_ID` empty for now.
7. `npm run deploy`
8. Register the webhook:
   ```sh
   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://spending-bot.<subdomain>.workers.dev npm run setup:telegram
   ```
   Telegram only delivers message edits to webhooks registered with `edited_message`.
   The "/" command menu needs no step: after each update the Worker checks the menu in `src/commands/menu.ts` against what it last registered (table `bot_state`), and re-registers it when it changed.
9. Run `npx wrangler tail`, add the bot to the group, and send `/help`. The log prints the group's `chat_id`, which is a negative number.
10. Put that id in `ALLOWED_CHAT_ID` in `wrangler.toml` and run `npm run deploy` again.
    The next message in the group moves the command menu from all groups to that group only.

Test this in a private group with two accounts before you add the bot to the real group.

### Continuous deploy

After the first deploy, `.github/workflows/spending-bot.yml` applies remote D1 migrations and runs `wrangler deploy` on every push to `main` that touches this app, once typecheck and tests pass.
You can also start it by hand from the Actions tab (`workflow_dispatch`).
It needs, in the repo's `production` environment or repo settings:

- `CLOUDFLARE_API_TOKEN` secret: a Cloudflare API token with **Account > Workers Scripts > Edit** and **Account > D1 > Edit**.
- `CLOUDFLARE_ACCOUNT_ID` variable: the account id from `npx wrangler whoami`.

## LLM features (free, optional)

Two features use [Workers AI](https://developers.cloudflare.com/workers-ai/) through the `AI` binding. It needs no API key, and the Workers Free plan includes a daily allowance (10,000 Neurons, reset at 00:00 UTC). Past the allowance, requests fail instead of being billed. On Workers Paid, usage above the allowance is billed.

- **Categories.** After each `/add` the bot replies first. Then it asks the model to put the note into one of the fixed categories in `src/ai/categories.ts`. The answer is cached per note, so `cafe` is classified only once. If the call fails, the expense stays uncategorised and the daily cron retries it. `/summary`, `/groupsummary` and the monthly summary show totals per category; anything not classified yet is listed as "Chưa phân loại".
- **Monthly commentary.** The monthly summary ends with 2–3 sentences from the model. The model only receives the totals computed in SQL. A reply that cites a number not in those totals is dropped. If the commentary fails, the summary is still sent, with a line saying the commentary is unavailable. `/summary` and `/groupsummary` never call the model for commentary.

The model is `LLM_MODEL` in `wrangler.toml` (default: `@cf/aisingapore/gemma-sea-lion-v4-27b-it`, a model tuned for Southeast Asian languages). Set it to `""` to switch both features off. Expense notes, member first names and totals are sent to Workers AI.

Tests stub `env.AI.run` (`remoteBindings: false` in `vitest.config.ts`), so they need no Cloudflare account. `wrangler dev` calls the real Workers AI and needs `wrangler login`.

## Google Sheets sync (optional)

The bot can keep a Google Sheet with one tab per month, named like `2026-10`, so members can browse, filter and download their spending.
Each tab lists the month's expenses (date, member, amount, category, note), sorted by member and then by date.
Next to them are each member's total and number of expenses, largest total first, and the group's total.
The monthly summary ends with a link to the month's tab.

The tabs follow D1, never the other way round.
After a command, once the reply is sent, the bot rewrites the tab of every month whose expenses changed, including through edits, `/undo` and a member's new name.
The nightly cron at 21:00 ICT does the same for anything still behind.
New month tabs go newest first, after any tabs you made yourself.
Every tab named `YYYY-MM` belongs to the bot, even one you created: the bot takes it over and overwrites it when that month changes.
Tabs with any other name are left alone.
Its tabs are protected with a warning, because an edit made in them is overwritten the next time that month changes.
Keep notes or charts in a tab of your own instead.

### Setup

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable the **Google Sheets API**, and create a service account without roles.
   Create a JSON key for it.
2. Create the spreadsheet with your own Google account and share it with the service account's `client_email` as **Editor**.
3. Set the spreadsheet's **General access** to **Anyone with the link** as **Viewer**, so members can open the links the bot posts.
4. Put the spreadsheet id, the part of its URL between `/d/` and `/edit`, in `GOOGLE_SHEET_ID` in `wrangler.toml`.
5. Run `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY < key.json`, then delete `key.json`.
6. Optional: put your numeric Telegram user id (ask @userinfobot) in `ADMIN_USER_ID` in `wrangler.toml`, then press **Start** in a private chat with the bot.
   The bot replies that this is where its Sheet alerts go; anyone else who messages it privately is told it only works in the group.
   When the nightly run cannot update the Sheet, the bot tells you there, and tells you again once it works.
7. Deploy as usual.
   The first command or nightly run afterwards writes the tabs of the existing months, up to 12 per run.

### Behaviour

- When Google fails, for example because the Sheet is no longer shared with the service account, the month stays marked as behind and the next command or nightly run tries again.
  Brief Google errors (429 and 5xx) are also retried on the spot, twice.
- The admin gets one message per outage, with Google's error, and one when it is over.
  Without `ADMIN_USER_ID`, failures only appear in the Worker log (`npx wrangler tail`).
- When a month's tab is still behind at the monthly summary, the summary says so instead of linking to it.
- A month tab that someone deleted comes back with the next change to that month.
  To rewrite every tab now, for example after changing the layout in `src/sheets/tab.ts`, run `npx wrangler d1 execute spending-bot-db --remote --command "UPDATE sheet_sync SET version = version + 1"` and then send any command in the group.
- Member names, dates, amounts, notes and categories are sent to Google.
- Set `GOOGLE_SHEET_ID = ""` to switch the sync off.
- Tests talk to a fake Google (`test/sheets.test.ts`), and `vitest.config.ts` blanks the Sheets settings, so tests never see the real key.
  `wrangler dev` reads the key from `.dev.vars` (see `.dev.vars.example`) and writes to the real Sheet, unless you pass `--var GOOGLE_SHEET_ID:<id of a copy>`.

## Mini App

A read-only page inside Telegram that shows one month of the group's spending.
It has the total with the change from the previous month, a bar chart by day, the breakdown by category and by member, and the list of expenses grouped by day.
Each member can switch between the whole group, their own spending and any other member's, and step back through earlier months.
Tapping a day or a category filters the list; a picked category also redraws the daily chart.
It follows the Telegram theme, light or dark.

The Worker serves the page at `/app/` and its data at `/api/month`.
Only members of `ALLOWED_CHAT_ID` see the data:

- The page sends the init data Telegram gives it, and the Worker checks its signature against the bot token, so the user id in it is trusted.
  Init data older than 24 hours is refused, and the page asks to be reopened.
- The Worker then asks Telegram (`getChatMember`) whether that user is in the group right now.
  Someone who left or was removed loses access at once.
- The page is a static file with nothing private in it.
  It sends no third-party requests other than Telegram's own `telegram-web-app.js`, and its Content-Security-Policy (`web/_headers`) allows nothing else.

Mid-month, the change is measured against the same days of the previous month, for example "so với 1-16/10", not against the whole month.

### Setup

1. In @BotFather, open the bot, then **Bot Settings > Configure Mini App > Enable Mini App**, and set the URL to `https://spending-bot.<subdomain>.workers.dev/app/`.
   This is the bot's Main Mini App, which `/app` links to as `https://t.me/<bot>?startapp`.
2. Optional: in **Bot Settings > Menu Button**, set the same URL, so the app also opens from the button next to the message box in a private chat with the bot.

Telegram does not allow Mini App buttons in groups, so `/app` posts a link button instead; Telegram opens the Mini App from it.

### Develop

`wrangler dev` builds the page (`[build]` in `wrangler.toml`) and rebuilds it when `web/` changes.
Outside Telegram the page has no init data and says to open it from the bot.
To try it in a browser, open `http://localhost:8787/app/#tgWebAppData=<init data>&tgWebAppVersion=8.0&tgWebAppPlatform=ios`, with init data signed by the `BOT_TOKEN` that `wrangler dev` uses.
Membership is still checked against the real Telegram, so that token must be the real bot's.

## Behaviour notes

- Any POST without the correct `X-Telegram-Bot-Api-Secret-Token` gets a 401 (GET requests are the Mini App, see above). Once the secret is valid, the Worker always answers 200, so Telegram never retries and creates duplicates. Duplicate updates are also skipped through `processed_updates`, which the daily cron prunes after 7 days.
- Until `ALLOWED_CHAT_ID` is set, the bot only logs chat ids. After that it leaves every other group and answers DMs with a one-line notice.
- Cron schedules are in UTC: `0 14 * * *` is 21:00 ICT (the daily recap, sent only when it is on and there was spending today). `0 2 1 * *` is 09:00 ICT on the 1st (the monthly summary, always sent).
- Editing an `/add` message updates that expense (amount, note and date).
  Relative dates count from the day the message was sent, not the day it was edited.
  The expense is re-categorised when the note changed.
  If the original `/add` was rejected, the fixed edit records it.
  An invalid edit is answered with the error and the old entry is kept.
  An expense removed with `/undo` stays removed, and the bot says so.
  An edit that turns a plain message or another command into a valid `/add` records it.
  Any other edit that does not result in an `/add` (for example an `/add` changed into another command) is ignored.
- Defaults chosen from the plan's open decisions: replies in Vietnamese, any member can run `/daily`, and `/undo` removes your last entry whatever its age.
- A reply `/undo` only deletes an expense the sender recorded. Replying to anything else (someone else's `/add`, a non-expense message, an already deleted one) deletes nothing and says so. In forum topics, the implicit reply to the topic's opening message counts as a plain `/undo`.
- Monthly budget (`/budget`): only expenses dated in the current ICT month count.
  At 80% and 100% of the budget the bot posts one separate warning per level per month, after the `/add` reply.
  One expense that jumps past both levels gives a single 100% warning.
  Changing the budget treats levels already reached under the new amount as announced and re-arms the rest.
  `/budget off` clears everything, including the warning state.
  `/undo` does not re-arm warnings.
