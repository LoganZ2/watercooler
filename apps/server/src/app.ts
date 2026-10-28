import { Hono } from 'hono';
import type { AppDeps, AppEnv } from './context';
import { HttpError } from './lib/http';
import { loadSessionUser } from './lib/session';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { marketRoutes } from './routes/markets';
import { userRoutes } from './routes/users';
import { tradingRoutes } from './routes/trading';
import { expireExchangeOrders } from './services/exchange';
import { cancelOverdueMarkets } from './services/bets';

/** Endpoints reachable without a session even in private mode. */
const PUBLIC_IN_PRIVATE_MODE = new Set([
  '/api/config',
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
]);

export function createApp(deps: AppDeps) {
  const api = new Hono<AppEnv>();

  // CSRF defence: POSTs must be JSON, which browsers cannot send cross-site without a
  // CORS preflight (and we never answer preflights). PUT/PATCH/DELETE always need one.
  api.use('*', async (c, next) => {
    if (c.req.method === 'POST') {
      const type = c.req.header('content-type') ?? '';
      if (!type.toLowerCase().startsWith('application/json')) {
        return c.json({ error: '请求必须是 JSON' }, 415);
      }
    }
    await next();
  });

  api.use('*', async (c, next) => {
    // Release open orders at trading close; positions wait for the creator's resolution.
    expireExchangeOrders(deps.db, deps.now());
    cancelOverdueMarkets(deps.db, deps.now());
    c.set('user', loadSessionUser(c, deps.db, deps.config.basePath || '/', deps.now()));
    if (deps.config.privateMode && !c.get('user') && !PUBLIC_IN_PRIVATE_MODE.has(c.req.path)) {
      return c.json({ error: '请先登录' }, 401);
    }
    await next();
  });

  api.route('/', authRoutes(deps));
  api.route('/', marketRoutes(deps));
  api.route('/', userRoutes(deps));
  api.route('/', tradingRoutes(deps));
  api.route('/', adminRoutes(deps));

  api.notFound((c) => c.json({ error: '接口不存在' }, 404));
  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: '服务器内部错误' }, 500);
  });

  const app = new Hono<AppEnv>();
  app.route('/api', api);
  return app;
}
