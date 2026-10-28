import {
  adminBalanceSchema,
  adminFeatureSchema,
  adminSiteConfigSchema,
  adminGrantAllSchema,
  adminMimicSchema,
  adminUserSchema,
  type AdminAuditEntry,
  type AdminInstanceConfig,
  type AdminOverview,
  type AdminUser,
} from '@watercooler/shared';
import { Hono } from 'hono';
import { requireAdmin, type AppDeps, type AppEnv } from '../context';
import { conflict, parseBody } from '../lib/http';
import {
  adjustUserBalance,
  audit,
  FEATURE_REQUIRES,
  featureOn,
  getFeatureFlags,
  grantAll,
  listAudit,
  listUsers,
  moneyOverview,
  setAdmin,
  setFeatureFlag,
} from '../services/admin';
import { describeInstanceConfig, readText, saveSiteConfig } from '../services/instanceConfig';
import { getMimicTopK, setMimicTopK } from '../mimic/sync';

/** Instance management; every route needs an admin (see requireAdmin). */
export function adminRoutes({ db, config, now, runtime, restart }: AppDeps) {
  const app = new Hono<AppEnv>();
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  // The .env file as this process found it; a difference later means a restart is due.
  const envAtStart = readText(config.envFilePath);
  const restartNeeded = () => readText(config.envFilePath) !== envAtStart;

  const overview = (): AdminOverview => ({
    instance: config.instance,
    release: config.release,
    startedAt,
    restartAvailable: restart !== undefined,
    restartNeeded: restartNeeded(),
    features: runtime?.features() ?? [],
    mimicTopK: getMimicTopK(db),
    money: moneyOverview(db),
  });

  app.get('/admin/overview', (c) => {
    requireAdmin(c);
    return c.json(overview());
  });

  app.post('/admin/features', async (c) => {
    const admin = requireAdmin(c);
    const { key, enabled } = await parseBody(c, adminFeatureSchema);
    const needs = FEATURE_REQUIRES[key];
    if (enabled && needs && !featureOn(getFeatureFlags(db), needs)) throw conflict('先打开「Polymarket 模式」');
    setFeatureFlag(db, admin.id, key, enabled, now());
    // The mirror starts syncing right away; Polymarket is checked on every new market.
    await runtime?.apply();
    return c.json(overview());
  });

  app.post('/admin/mimic', async (c) => {
    const admin = requireAdmin(c);
    const { topK } = await parseBody(c, adminMimicSchema);
    setMimicTopK(db, admin.id, topK, now());
    // The next pass picks up the new size; start one now rather than in a few minutes.
    void runtime?.syncMimic?.();
    return c.json(overview());
  });

  app.post('/admin/restart', (c) => {
    const admin = requireAdmin(c);
    if (!restart) throw conflict('这个环境不支持在线重启（只有服务器上部署的实例可以）');
    audit(db, admin.id, 'restart', '重启实例', now());
    // Answer first: the restart stops this very process.
    setTimeout(restart, 500);
    return c.json({ ok: true });
  });

  const configView = () => describeInstanceConfig(config, restartNeeded());

  app.get('/admin/config', (c) => {
    requireAdmin(c);
    return c.json<AdminInstanceConfig>(configView());
  });

  app.post('/admin/config/site', async (c) => {
    const admin = requireAdmin(c);
    const input = await parseBody(c, adminSiteConfigSchema);
    saveSiteConfig(config.envFilePath, input);
    audit(
      db,
      admin.id,
      'config',
      `更新站点设置（${input.inviteCode ? '需要邀请码' : '不需要邀请码'}，${input.privateMode ? '私有模式' : '公开浏览'}，注册赠送 ${input.startingBalance}，每日签到 ${input.dailyBonus}，时区 ${input.timezone}）`,
      now(),
    );
    return c.json<AdminInstanceConfig>(configView());
  });

  app.get('/admin/users', (c) => {
    requireAdmin(c);
    return c.json<AdminUser[]>(listUsers(db, c.req.query('q'), Number(c.req.query('limit')) || undefined));
  });

  app.post('/admin/balance', async (c) => {
    const admin = requireAdmin(c);
    const input = await parseBody(c, adminBalanceSchema);
    return c.json<AdminUser>(adjustUserBalance(db, admin.id, input.username, input.amount, input.reason, now()));
  });

  app.post('/admin/balance/all', async (c) => {
    const admin = requireAdmin(c);
    const input = await parseBody(c, adminGrantAllSchema);
    return c.json({ users: grantAll(db, admin.id, input.amount, input.reason, now()) });
  });

  app.post('/admin/admins', async (c) => {
    const admin = requireAdmin(c);
    const { username } = await parseBody(c, adminUserSchema);
    return c.json<AdminUser>(setAdmin(db, admin.id, username, true, now()));
  });

  app.post('/admin/admins/remove', async (c) => {
    const admin = requireAdmin(c);
    const { username } = await parseBody(c, adminUserSchema);
    return c.json<AdminUser>(setAdmin(db, admin.id, username, false, now()));
  });

  app.get('/admin/audit', (c) => {
    requireAdmin(c);
    const before = Number(c.req.query('before')) || undefined;
    return c.json<AdminAuditEntry[]>(listAudit(db, { before }));
  });

  return app;
}
