import {
  adminBalanceSchema,
  adminFeatureSchema,
  adminGrantAllSchema,
  adminUserSchema,
  type AdminAuditEntry,
  type AdminOverview,
  type AdminUser,
} from '@watercooler/shared';
import { Hono } from 'hono';
import { requireAdmin, type AppDeps, type AppEnv } from '../context';
import { conflict, parseBody } from '../lib/http';
import {
  adjustUserBalance,
  audit,
  grantAll,
  listAudit,
  listUsers,
  moneyOverview,
  setAdmin,
  setFeatureFlag,
} from '../services/admin';

/** Instance management; every route needs an admin (see requireAdmin). */
export function adminRoutes({ db, config, now, runtime, restart }: AppDeps) {
  const app = new Hono<AppEnv>();
  const startedAt = Math.round(Date.now() - process.uptime() * 1000);

  const overview = (): AdminOverview => ({
    instance: config.instance,
    release: config.release,
    startedAt,
    restartAvailable: restart !== undefined,
    features: runtime?.features() ?? [],
    money: moneyOverview(db),
  });

  app.get('/admin/overview', (c) => {
    requireAdmin(c);
    return c.json(overview());
  });

  app.post('/admin/features', async (c) => {
    const admin = requireAdmin(c);
    const { key, enabled } = await parseBody(c, adminFeatureSchema);
    setFeatureFlag(db, admin.id, key, enabled, now());
    // Bots and the WeCom bot start or stop right away; Polymarket is checked on every new market.
    await runtime?.apply();
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

  app.get('/admin/users', (c) => {
    requireAdmin(c);
    return c.json<AdminUser[]>(listUsers(db, c.req.query('q')));
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
