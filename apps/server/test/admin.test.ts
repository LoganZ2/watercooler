import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/bots/config';
import { createRuntime } from '../src/runtime';
import type { WecomService } from '../src/wecom/bot';
import { setup } from './helpers';

const DAY = 86_400_000;

/** An instance whose first admin was made on the server (cli make-admin), plus an ordinary user. */
async function adminEnv(extra: Parameters<typeof setup>[1] = () => ({})) {
  const env = setup({}, extra);
  const admin = await env.register('boss');
  const alice = await env.register('alice');
  env.db.prepare(`UPDATE users SET is_admin = 1 WHERE username = 'boss'`).run();
  return { env, admin, alice };
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

  it('starts and stops the bots and the WeCom bot from the flags and the current bot.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-admin-'));
    const botPath = join(dir, 'bot.json');
    const running = { bots: 0, wecom: 0 };
    const started: BotConfig[] = [];
    let runtime!: ReturnType<typeof createRuntime>;
    const { env, admin } = await adminEnv((base) => {
      runtime = createRuntime({
        ...base,
        config: { ...base.config, botConfigPath: botPath },
        log: () => {},
        startBots: async (bot) => {
          running.bots++;
          started.push(bot);
          return () => running.bots--;
        },
        startWecom: () => {
          running.wecom++;
          return { announceBinding: () => {}, connected: () => true, stop: () => running.wecom-- } as WecomService;
        },
      });
      return { runtime };
    });
    try {
      const feature = async (key: string) =>
        (await admin.get('/admin/overview')).body.features.find((f: { key: string }) => f.key === key);

      await runtime.apply();
      expect(await feature('aiBots')).toMatchObject({ enabled: true, active: false, problem: '服务器上没有 bot.json' });
      expect((await admin.get('/config')).body).toMatchObject({ aiZone: false, wecom: false });

      writeFileSync(botPath, JSON.stringify({ apiKey: 'k', model: 'm' }));
      await runtime.apply();
      expect(running).toEqual({ bots: 1, wecom: 0 });
      expect(await feature('wecom')).toMatchObject({ problem: 'bot.json 里没有 wecom 配置' });

      writeFileSync(
        botPath,
        JSON.stringify({ apiKey: 'k', model: 'm', wecom: { botId: 'b', secret: 's', siteUrl: 'https://x.com/wc' } }),
      );
      await runtime.apply();
      // Adding WeCom credentials leaves the bots alone and starts the WeCom bot.
      expect(running).toEqual({ bots: 1, wecom: 1 });
      expect(started).toHaveLength(1);
      expect((await admin.get('/config')).body).toMatchObject({ aiZone: true, wecom: true });

      await admin.post('/admin/features', { key: 'aiBots', enabled: false });
      await admin.post('/admin/features', { key: 'wecom', enabled: false });
      expect(running).toEqual({ bots: 0, wecom: 0 });
      expect(await feature('aiBots')).toMatchObject({ enabled: false, active: false, problem: null });

      await admin.post('/admin/features', { key: 'aiBots', enabled: true });
      expect(running).toEqual({ bots: 1, wecom: 0 });

      // A changed model restarts the bots with the new settings.
      writeFileSync(botPath, JSON.stringify({ apiKey: 'k', model: 'm2' }));
      await runtime.apply();
      expect(running.bots).toBe(1);
      expect(started.at(-1)!.model).toBe('m2');
      runtime.stop();
      expect(running).toEqual({ bots: 0, wecom: 0 });
    } finally {
      env.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
