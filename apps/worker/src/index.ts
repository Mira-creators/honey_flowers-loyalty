import app from './app.js';
import { createContext } from './context.js';
import { runDailyJob } from './cron.js';
import type { Env } from './env.js';

/** Cloudflare Worker entry: HTTP (Hono app) + daily cron. */
export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const appCtx = await createContext(env, { waitUntil: (p) => ctx.waitUntil(p) });
    const res = await runDailyJob(appCtx);
    console.log(`daily job (${controller.cron}): expired=${res.expired} warned=${res.warned}`);
  },
} satisfies ExportedHandler<Env>;
