import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  fromCents,
  type AppConfig,
} from '@watercooler/shared';
import { Hono } from 'hono';
import { requireUser, type AppDeps, type AppEnv } from '../context';
import { badRequest, forbidden, HttpError, parseBody, unauthorized } from '../lib/http';
import { hashPassword, verifyPassword } from '../lib/password';
import { RateLimiter } from '../lib/rateLimit';
import { endSession, revokeSessions, startSession } from '../lib/session';
import { MINUTE } from '../lib/time';
import { featureOn, getFeatureFlags } from '../services/admin';
import { claimDailyBonus, createUser, getUserById, getUserByUsername, toMe } from '../services/users';

export function authRoutes({ db, config, now }: AppDeps) {
  const app = new Hono<AppEnv>();
  const loginFailures = new RateLimiter(10, 15 * MINUTE);
  const registrations = new RateLimiter(20, 60 * MINUTE);
  const cookiePath = config.basePath || '/';

  app.get('/config', (c) => {
    const flags = getFeatureFlags(db);
    return c.json<AppConfig>({
      inviteRequired: config.inviteCode !== null,
      startingBalance: config.startingBalance,
      dailyBonus: config.dailyBonus,
      privateMode: config.privateMode,
      polymarket: flags.polymarket,
      mimic: featureOn(flags, 'mimic'),
    });
  });

  app.get('/auth/me', (c) => {
    const user = c.get('user');
    return c.json({ user: user ? toMe(user, config, now()) : null });
  });

  app.post('/auth/register', async (c) => {
    const input = await parseBody(c, registerSchema);
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    if (!registrations.check(ip)) throw new HttpError(429, '注册太频繁，请稍后再试');
    if (config.inviteCode !== null && input.inviteCode !== config.inviteCode) throw forbidden('邀请码不正确');
    registrations.hit(ip);
    const t = now();
    const user = await createUser(db, config, input, t);
    startSession(c, db, cookiePath, user.id, t);
    return c.json({ user: toMe(user, config, t) }, 201);
  });

  app.post('/auth/login', async (c) => {
    const input = await parseBody(c, loginSchema);
    const key = input.username.toLowerCase();
    if (!loginFailures.check(key)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
    const user = getUserByUsername(db, input.username);
    // Always run a hash comparison so response time does not reveal whether the user exists.
    const ok = await verifyPassword(input.password, user?.password_hash ?? 'scrypt$16384$8$1$AAAA$AAAA');
    if (!user || !ok || user.is_bot) {
      loginFailures.hit(key);
      throw unauthorized('用户名或密码错误');
    }
    loginFailures.reset(key);
    const t = now();
    startSession(c, db, cookiePath, user.id, t);
    return c.json({ user: toMe(user, config, t) });
  });

  app.post('/auth/logout', (c) => {
    endSession(c, db, cookiePath);
    return c.json({ ok: true });
  });

  app.post('/auth/password', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, changePasswordSchema);
    if (!(await verifyPassword(input.oldPassword, user.password_hash))) throw badRequest('当前密码不正确');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(input.newPassword), user.id);
    revokeSessions(c, db, user.id, true);
    return c.json({ ok: true });
  });

  app.post('/me/profile', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, updateProfileSchema);
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(input.displayName, user.id);
    return c.json({ user: toMe(getUserById(db, user.id)!, config, now()) });
  });

  app.post('/me/bonus', (c) => {
    const user = requireUser(c);
    const balance = claimDailyBonus(db, config, user.id, now());
    return c.json({ balance: fromCents(balance), amount: config.dailyBonus });
  });

  return app;
}
