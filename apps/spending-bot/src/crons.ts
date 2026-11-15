// The cron schedules in wrangler.toml ([triggers] crons), in UTC. scheduled() dispatches on them.
// They live here, not in index.ts: workerd refuses to start a Worker whose entry module exports
// anything but handlers, so `wrangler dev` failed on these two strings.

/** 21:00 ICT every day: the daily recap and the nightly jobs. */
export const DAILY_CRON = "0 14 * * *";
/** 09:00 ICT on the 1st: the monthly summary. */
export const MONTHLY_CRON = "0 2 1 * *";
