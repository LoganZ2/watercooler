import {
  adminAiConfigSchema,
  adminBalanceSchema,
  adminFeatureSchema,
  adminSiteConfigSchema,
  adminWecomConfigSchema,
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
import {
  describeInstanceConfig,
  readText,
  removeWecomConfig,
  saveAiConfig,
  saveSiteConfig,
  saveWecomConfig,
} from '../services/instanceConfig';
import { getMimicTopK, setMimicTopK } from '../mimic/sync';

/** Instance management; every route needs an admin (see requireAdmin). */
export function adminRoutes({ db, config, now, runtime, restart }: AppDeps) {
  const app = new Hono<AppEnv>();
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);
  // The configuration files as this process found them; a difference later means a restart is due.
  const botAtStart = readText(config.botConfigPath);
  const envAtStart = readText(config.envFilePath);
  const restartNeeded = () =>
    readText(config.botConfigPath) !== botAtStart || readText(config.envFilePath) !== envAtStart;

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
    // The flag alone decides what runs, so it may only go on once the running instance has the
    // credentials (saved ones count after the restart).
    if (
      enabled &&
      (key === 'aiBots' || key === 'wecom') &&
      !runtime?.features().find((f) => f.key === key)?.configured
    ) {
      throw conflict(
        key === 'wecom'
          ? '还没有企业微信配置：先在「配置」里填写并重启'
          : '还没有 AI 模型配置：先在「配置」里填写并重启',
      );
    }
    const needs = FEATURE_REQUIRES[key];
    if (enabled && needs && !featureOn(getFeatureFlags(db), needs)) throw conflict('先打开「Polymarket 模式」');
    setFeatureFlag(db, admin.id, key, enabled, now());
    // Bots and the WeCom bot start or stop right away; Polymarket is checked on every new market.
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

  app.post('/admin/config/ai', async (c) => {
    const admin = requireAdmin(c);
    const input = await parseBody(c, adminAiConfigSchema);
    const newKey = saveAiConfig(config.botConfigPath, input);
    audit(db, admin.id, 'config', `更新 AI 模型配置（模型 ${input.model}${newKey ? '，更换了 API key' : ''}）`, now());
    return c.json<AdminInstanceConfig>(configView());
  });

  app.post('/admin/config/wecom', async (c) => {
    const admin = requireAdmin(c);
    const input = await parseBody(c, adminWecomConfigSchema);
    const newSecret = saveWecomConfig(config.botConfigPath, input);
    audit(db, admin.id, 'config', `更新企业微信配置${newSecret ? '（更换了 Secret）' : ''}`, now());
    return c.json<AdminInstanceConfig>(configView());
  });

  app.post('/admin/config/wecom/remove', (c) => {
    const admin = requireAdmin(c);
    removeWecomConfig(config.botConfigPath);
    audit(db, admin.id, 'config', '移除企业微信配置', now());
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
