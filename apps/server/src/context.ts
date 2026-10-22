import type { PolymarketClient } from './mimic/client';
import type { Context } from 'hono';
import type { Config } from './config';
import type { DB } from './db';
import { forbidden, unauthorized } from './lib/http';
import type { UserRow } from './services/users';
import type { AppRuntime } from './runtime';

export interface AppDeps {
  db: DB;
  config: Config;
  /** Injectable clock, for tests and seeding. */
  now: () => number;
  /** AI bots and the WeCom bot, switched by feature flags; absent where nothing runs in the background. */
  runtime?: AppRuntime;
  /** Restarts the whole instance; absent when it is not run by the deploy's control script. */
  restart?: () => void;
  /** Polymarket's public APIs for trading mirrors; the real ones unless a test passes a fake. */
  polymarket?: PolymarketClient;
}

export interface AppEnv {
  Variables: {
    user: UserRow | null;
  };
}

export type Ctx = Context<AppEnv>;

export function requireUser(c: Ctx): UserRow {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function requireAdmin(c: Ctx): UserRow {
  const user = requireUser(c);
  if (!user.is_admin) throw forbidden('需要管理员权限');
  return user;
}
