import app from './app.js';
import { createContext } from './context.js';
import type { Env } from './env.js';
import { alertChatIds, envName, sendToAlertChats } from './lib/alerts.js';
import { countingD1, SubrequestBudget } from './lib/budget.js';
import { runDailyJobMonitored } from './lib/monitor.js';

/** Cloudflare Worker entry: HTTP (Hono app) + the daily job, run every hour (cron "0 * * * *"). */
export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Every D1 round trip of this invocation is charged to a budget of 45 (Workers Free: 50 subrequests).
    const budget = new SubrequestBudget(45);
    const counted: Env = { ...env, DB: countingD1(env.DB, budget) };
    let appCtx;
    try {
      appCtx = await createContext(counted, { waitUntil: (p) => ctx.waitUntil(p) });
    } catch (err) {
      // Not even the context could be built (e.g. D1 unreachable): still tell the team.
      if (alertChatIds(env).length) {
        ctx.waitUntil(sendToAlertChats(env, `🚨 Honey Flowers · ${envName(env)}\nНочная задача не запустилась: ${err instanceof Error ? err.message : String(err)}`));
      }
      throw err;
    }
    // Stores a cron_runs row and alerts on failure (lib/monitor.ts); re-throws a total failure.
    const res = await runDailyJobMonitored(appCtx, 'cron', { respectQuietHours: true, realNowMs: controller.scheduledTime, budget });
    console.log(
      `daily job (${controller.cron}): checked=${res.checked} expired=${res.expired} warned=${res.warned} burned=${res.burned} failed=${res.failed} more=${res.more} sent=${res.sent} sendFailed=${res.sendFailed} subrequests=${budget.used}`,
    );
  },
} satisfies ExportedHandler<Env>;
