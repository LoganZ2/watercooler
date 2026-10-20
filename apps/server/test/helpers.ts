import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { AppDeps } from '../src/context';
import { openDatabase } from '../src/db';
import type { AppRuntime } from '../src/runtime';

/** Background services that are simply there (or not), for tests that don't exercise feature flags. */
export function fixedRuntime(services: { bots?: boolean; wecom?: ReturnType<AppRuntime['wecom']> } = {}): AppRuntime {
  return {
    botsRunning: () => services.bots ?? false,
    wecom: () => services.wecom,
    features: () => [],
    apply: async () => {},
  };
}

/** `extra` adds optional app dependencies (like the WeCom bot), built from the test's db and clock. */
export function setup(
  overrides: Partial<Config> = {},
  extra: (deps: Pick<AppDeps, 'db' | 'config' | 'now'>) => Partial<AppDeps> = () => ({}),
) {
  const db = openDatabase(':memory:');
  const config: Config = { ...loadConfig({}), staticDir: null, ...overrides };
  const clock = { now: Date.UTC(2026, 0, 1, 4) };
  const base = { db, config, now: () => clock.now };
  const app = createApp({ ...base, ...extra(base) });

  function client() {
    let cookie = '';
    async function call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await app.request(`http://localhost/api${path}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      return { status: res.status, body: (await res.json()) as T };
    }
    return {
      get: <T = any>(path: string) => call<T>('GET', path),
      post: <T = any>(path: string, body: unknown = {}) => call<T>('POST', path, body),
      del: <T = any>(path: string) => call<T>('DELETE', path),
      raw: call,
    };
  }

  async function register(username: string, password = 'secret123') {
    const c = client();
    const res = await c.post('/auth/register', { username, displayName: username.toUpperCase(), password });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return c;
  }

  return { db, config, clock, app, client, register };
}
