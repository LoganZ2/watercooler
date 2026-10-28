import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/context';
import { createRuntime, type AppRuntime, type Runtime } from '../src/runtime';
import { fakePolymarket, setup } from './helpers';

const DAY = 86_400_000;

/** An instance whose first admin was made on the server (cli make-admin), plus an ordinary user. */
async function adminEnv(extra: Parameters<typeof setup>[1] = () => ({})) {
  const env = setup({}, extra);
  const admin = await env.register('boss');
  const alice = await env.register('alice');
  env.db.prepare(`UPDATE users SET is_admin = 1 WHERE username = 'boss'`).run();
  return { env, admin, alice };
}

/**
 * An admin env with real feature flags, a fake Polymarket and a .env file. restart() starts a fresh
 * runtime over the same database, the way restarting the instance does.
 */
async function runtimeEnv(envText?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-admin-'));
  const files = { dir, env: join(dir, '.env') };
  if (envText !== undefined) writeFileSync(files.env, envText);
  let current: Runtime | undefined;
  const proxy: AppRuntime = {
    features: () => current?.features() ?? [],
    apply: async () => current?.apply(),
  };
  let base!: Pick<AppDeps, 'db' | 'config' | 'now'>;
  const env = setup({ envFilePath: files.env }, (b) => {
    base = b;
    return { runtime: proxy };
  });
  const admin = await env.register('boss');
  const alice = await env.register('alice');
  env.db.prepare(`UPDATE users SET is_admin = 1 WHERE username = 'boss'`).run();
  const restart = async () => {
    current?.stop();
    current = createRuntime({ polymarket: fakePolymarket().client, ...base, log: () => {} });
    await current.apply();
  };
  return { env, admin, alice, files, restart };
}

describe('admin console', () => {
  it('is for admins only, and admins appoint each other but never drop themselves', async () => {
    const { env, admin, alice } = await adminEnv();
    expect((await admin.get('/auth/me')).body.user.isAdmin).toBe(true);
    expect((await alice.get('/auth/me')).body.user.isAdmin).toBe(false);
    expect((await alice.get('/admin/overview')).status).toBe(403);
    expect((await alice.post('/admin/admins', { username: 'alice' })).status).toBe(403);

    expect((await admin.post('/admin/admins', { username: 'alice' })).body).toMatchObject({ isAdmin: true });
    expect((await alice.get('/admin/overview')).status).toBe(200);
    expect((await alice.post('/admin/admins/remove', { username: 'alice' })).status).toBe(400);
    expect((await alice.post('/admin/admins/remove', { username: 'boss' })).body).toMatchObject({ isAdmin: false });
    expect((await admin.get('/admin/overview')).status).toBe(403);
    expect((await alice.post('/admin/admins', { username: 'nobody' })).status).toBe(404);

    const users = (await alice.get('/admin/users?q=bo')).body;
    expect(users.map((u: { username: string }) => u.username)).toEqual(['boss']);
    const log = (await alice.get('/admin/audit')).body.map((a: { detail: string }) => a.detail);
    expect(log).toEqual(['取消管理员：BOSS（boss）', '设为管理员：ALICE（alice）']);
    env.db.close();
  });

  it('finds people for the user pickers from any letters of their name, best matches first', async () => {
    const { env, admin } = await adminEnv();
    for (const name of ['maxim', 'xiaoming', 'xiaohong', 'ma_li']) await env.register(name);
    env.db.prepare(`UPDATE users SET display_name = '小明' WHERE username = 'xiaoming'`).run();
    const find = async (q: string, limit = '') =>
      (await admin.get(`/admin/users?q=${encodeURIComponent(q)}&limit=${limit}`)).body.map(
        (u: { username: string }) => u.username,
      );

    expect(await find('m')).toEqual(['maxim', 'ma_li', 'xiaoming']);
    expect(await find('xm')).toEqual(['maxim', 'xiaoming']);
    expect(await find('小明')).toEqual(['xiaoming']);
    expect(await find('_')).toEqual(['ma_li']);
    expect(await find('%')).toEqual([]);
    expect(await find('i', '2')).toHaveLength(2);
    env.db.close();
  });

  it('switches Polymarket off for new markets and records who did it', async () => {
    const { env, admin, alice } = await adminEnv();
    const market = {
      question: 'Polymarket 开关有效吗？',
      category: '其他',
      mode: 'polymarket',
      closeAt: env.clock.now + DAY,
      outcomes: ['Yes', 'No'],
    };
    expect((await alice.get('/config')).body.polymarket).toBe(true);
    const open = (await alice.post('/markets', market)).body.id;

    expect((await admin.post('/admin/features', { key: 'polymarket', enabled: false })).status).toBe(200);
    expect((await alice.get('/config')).body.polymarket).toBe(false);
    expect((await alice.post('/markets', market)).status).toBe(403);
    expect((await alice.post('/markets', { ...market, mode: 'pool', outcomes: ['是', '否'] })).status).toBe(201);
    // Markets that already exist keep trading, so nobody's money gets stuck.
    expect((await alice.post(`/markets/${open}/split`, { quantity: 1 })).status).toBe(200);

    await admin.post('/admin/features', { key: 'polymarket', enabled: true });
    expect((await alice.post('/markets', market)).status).toBe(201);
    const log = (await admin.get('/admin/audit')).body;
    expect(log.map((a: { detail: string }) => a.detail)).toEqual([
      '开启「Polymarket 模式」',
      '关闭「Polymarket 模式」',
    ]);
    expect(log[0].admin).toMatchObject({ username: 'boss' });
    env.db.close();
  });

  it('adds and takes 水滴 as funding, so balances move but profit does not', async () => {
    const { env, admin, alice } = await adminEnv();
    const bob = await env.register('bob');
    const added = await admin.post('/admin/balance', { username: 'alice', amount: 250, reason: '活动奖励' });
    expect(added.body).toMatchObject({ username: 'alice', balance: 1250 });
    expect((await admin.post('/admin/balance', { username: 'alice', amount: -50, reason: '补扣' })).body.balance).toBe(
      1200,
    );
    expect((await admin.post('/admin/balance', { username: 'alice', amount: -5000, reason: '扣太多' })).status).toBe(
      400,
    );
    expect((await admin.post('/admin/balance', { username: 'alice', amount: 10, reason: '' })).status).toBe(400);
    expect((await admin.post('/admin/balance', { username: 'alice', amount: 0.001, reason: '太小了' })).status).toBe(
      400,
    );
    expect((await admin.post('/admin/balance/all', { amount: 100, reason: '节日福利' })).body).toEqual({ users: 3 });

    expect((await bob.get('/auth/me')).body.user.balance).toBe(1100);
    const ledger = (await alice.get('/portfolio/ledger')).body;
    expect(
      ledger.slice(0, 3).map((l: { kind: string; amount: number; note: string }) => [l.kind, l.amount, l.note]),
    ).toEqual([
      ['grant', 100, '节日福利'],
      ['grant', -50, '补扣'],
      ['grant', 250, '活动奖励'],
    ]);
    const board = (await alice.get('/leaderboard')).body;
    expect(board.find((e: { user: { username: string } }) => e.user.username === 'alice').stats).toMatchObject({
      profit: 0,
      funded: 1300,
    });

    const { money } = (await admin.get('/admin/overview')).body;
    expect(money).toEqual({ users: 3, balances: 3500, inMarkets: 0, funded: 3500 });
    env.db.close();
  });

  it('restarts only where the control script can, after answering', async () => {
    const plain = await adminEnv();
    expect((await plain.admin.post('/admin/restart')).status).toBe(409);
    plain.env.db.close();

    const restart = vi.fn();
    const { env, admin, alice } = await adminEnv(() => ({ restart }));
    expect((await alice.post('/admin/restart')).status).toBe(403);
    expect((await admin.get('/admin/overview')).body.restartAvailable).toBe(true);
    expect((await admin.post('/admin/restart')).status).toBe(200);
    expect(restart).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(restart).toHaveBeenCalledOnce();
    expect((await admin.get('/admin/audit')).body[0].detail).toBe('重启实例');
    env.db.close();
  });

  it('saves the site settings to .env, lists the switches and asks for a restart', async () => {
    const { env, admin, alice, files, restart } = await runtimeEnv('# 站点设置\nFOO=bar\nDAILY_BONUS=100\n');
    try {
      await restart();
      const config = async () => (await admin.get('/admin/config')).body;
      expect(await config()).toMatchObject({ restartNeeded: false });
      expect((await alice.get('/admin/config')).status).toBe(403);
      expect((await alice.post('/admin/config/site', {})).status).toBe(403);
      const overview = (await admin.get('/admin/overview')).body;
      expect(overview.features.map((f: { key: string }) => f.key)).toEqual(['polymarket', 'mimic']);
      expect(overview.restartNeeded).toBe(false);

      const site = {
        inviteCode: 'hello',
        privateMode: true,
        startingBalance: 500,
        dailyBonus: 20,
        timezone: 'Asia/Tokyo',
      };
      expect((await admin.post('/admin/config/site', { ...site, timezone: 'Mars/Base' })).status).toBe(400);
      expect((await admin.post('/admin/config/site', { ...site, inviteCode: 'a b' })).status).toBe(400);
      expect((await admin.post('/admin/config/site', site)).body.site).toEqual(site);
      expect(readFileSync(files.env, 'utf8')).toBe(
        '# 站点设置\nFOO=bar\nDAILY_BONUS=20\nINVITE_CODE=hello\nPRIVATE_MODE=true\nSTARTING_BALANCE=500\nAPP_TIMEZONE=Asia/Tokyo\n',
      );
      await admin.post('/admin/config/site', { ...site, inviteCode: '' });
      expect(readFileSync(files.env, 'utf8')).not.toContain('INVITE_CODE');
      // Nothing applies before the restart.
      expect((await alice.get('/config')).body).toMatchObject({ privateMode: false, dailyBonus: 100 });
      expect((await admin.get('/admin/overview')).body.restartNeeded).toBe(true);
      expect((await admin.get('/admin/audit')).body[0].detail).toContain('更新站点设置');
    } finally {
      env.db.close();
      rmSync(files.dir, { recursive: true, force: true });
    }
  });
});
