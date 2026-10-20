import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/context';
import { createRuntime, type AppRuntime, type Runtime } from '../src/runtime';
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

/**
 * An admin env with real feature flags and fake services. restart() starts a fresh runtime over
 * the same database, the way restarting the instance does.
 */
async function runtimeEnv(envText?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-admin-'));
  const files = { dir, bot: join(dir, 'bot.json'), env: join(dir, '.env') };
  if (envText !== undefined) writeFileSync(files.env, envText);
  const running = { bots: 0, wecom: 0 };
  let current: Runtime | undefined;
  const proxy: AppRuntime = {
    botsRunning: () => current?.botsRunning() ?? false,
    wecom: () => current?.wecom(),
    features: () => current?.features() ?? [],
    apply: async () => current?.apply(),
  };
  let base!: Pick<AppDeps, 'db' | 'config' | 'now'>;
  const env = setup({ botConfigPath: files.bot, envFilePath: files.env }, (b) => {
    base = b;
    return { runtime: proxy };
  });
  const admin = await env.register('boss');
  const alice = await env.register('alice');
  env.db.prepare(`UPDATE users SET is_admin = 1 WHERE username = 'boss'`).run();
  const restart = async () => {
    current?.stop();
    current = createRuntime({
      ...base,
      log: () => {},
      startBots: async () => {
        running.bots++;
        return () => running.bots--;
      },
      startWecom: () => {
        running.wecom++;
        return { announceBinding: () => {}, connected: () => true, stop: () => running.wecom-- } as WecomService;
      },
    });
    await current.apply();
  };
  return { env, admin, alice, files, running, restart };
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

  it('runs the bots and the WeCom bot exactly as the flags say, with credentials read at startup', async () => {
    const { env, admin, files, running, restart } = await runtimeEnv();
    try {
      const feature = async (key: string) =>
        (await admin.get('/admin/overview')).body.features.find((f: { key: string }) => f.key === key);
      const enable = (key: string, enabled = true) => admin.post('/admin/features', { key, enabled });

      // No credentials: the flags start off and cannot be switched on.
      await restart();
      expect(await feature('aiBots')).toMatchObject({ enabled: false, configured: false, active: false });
      expect((await enable('aiBots')).status).toBe(409);

      // Saved credentials count only after a restart.
      writeFileSync(files.bot, JSON.stringify({ apiKey: 'k', model: 'm' }));
      expect((await enable('aiBots')).status).toBe(409);
      await restart();
      // The flag stays off: having credentials does not switch anything on.
      expect(await feature('aiBots')).toMatchObject({ enabled: false, configured: true, active: false });
      expect(running).toEqual({ bots: 0, wecom: 0 });
      expect((await enable('aiBots')).status).toBe(200);
      expect(running).toEqual({ bots: 1, wecom: 0 });
      expect((await enable('wecom')).status).toBe(409);

      writeFileSync(
        files.bot,
        JSON.stringify({ apiKey: 'k', model: 'm', wecom: { botId: 'b', secret: 's', siteUrl: 'https://x.com/wc' } }),
      );
      await restart();
      expect(running).toEqual({ bots: 1, wecom: 0 });
      expect((await enable('wecom')).status).toBe(200);
      expect(running).toEqual({ bots: 1, wecom: 1 });
      expect((await admin.get('/config')).body).toMatchObject({ aiZone: true, wecom: true });

      await enable('wecom', false);
      expect(running).toEqual({ bots: 1, wecom: 0 });

      // On without credentials is reported as misconfigured, not quietly treated as off.
      rmSync(files.bot);
      await restart();
      expect(running).toEqual({ bots: 0, wecom: 0 });
      expect(await feature('aiBots')).toMatchObject({
        enabled: true,
        configured: false,
        active: false,
        problem: '缺少配置：服务器上没有 bot.json',
      });
      expect((await enable('aiBots', false)).status).toBe(200);
    } finally {
      env.db.close();
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it('switches flags on once from the credentials an instance already had, then leaves them alone', async () => {
    const { env, admin, files, running, restart } = await runtimeEnv();
    try {
      writeFileSync(
        files.bot,
        JSON.stringify({ apiKey: 'k', model: 'm', wecom: { botId: 'b', secret: 's', siteUrl: 'https://x.com/wc' } }),
      );
      await restart();
      expect(running).toEqual({ bots: 1, wecom: 1 });
      await admin.post('/admin/features', { key: 'wecom', enabled: false });
      await restart();
      expect(running).toEqual({ bots: 1, wecom: 0 });
    } finally {
      env.db.close();
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it('saves credentials and site settings to the files, masks secrets and asks for a restart', async () => {
    const { env, admin, alice, files } = await runtimeEnv('# 站点设置\nFOO=bar\nDAILY_BONUS=100\n');
    try {
      const config = async () => (await admin.get('/admin/config')).body;
      expect(await config()).toMatchObject({ ai: null, wecom: null, restartNeeded: false });
      expect((await alice.get('/admin/config')).status).toBe(403);
      expect((await alice.post('/admin/config/site', {})).status).toBe(403);

      const ai = {
        endpoint: 'https://api.anthropic.com',
        model: 'claude-opus-5-5',
        bots: 10,
        marketsPerDay: 2,
        betsPerDay: 50,
        flipProbability: 0.2,
      };
      expect((await admin.post('/admin/config/ai', ai)).body.error).toBe('请填写 API key');
      const saved = await admin.post('/admin/config/ai', { ...ai, apiKey: 'sk-ant-secret-1234' });
      expect(saved.body.ai).toMatchObject({ model: 'claude-opus-5-5', bots: 10, apiKeyHint: '已设置（…1234）' });
      expect(JSON.stringify(saved.body)).not.toContain('secret-1234');
      expect(statSync(files.bot).mode & 0o777).toBe(0o600);
      expect((await admin.get('/admin/overview')).body.restartNeeded).toBe(true);

      // Leaving the key empty keeps it.
      await admin.post('/admin/config/ai', { ...ai, model: 'claude-sonnet-5-5' });
      expect(JSON.parse(readFileSync(files.bot, 'utf8'))).toMatchObject({
        apiKey: 'sk-ant-secret-1234',
        model: 'claude-sonnet-5-5',
      });

      const wecom = {
        botId: 'bot1',
        siteUrl: 'https://ky-z.com/watercooler',
        siteName: 'Watercooler',
        messagesPerHour: 30,
      };
      expect((await admin.post('/admin/config/wecom', wecom)).body.error).toBe('请填写 Secret');
      const withWecom = (await admin.post('/admin/config/wecom', { ...wecom, secret: 'wecom-secret-9876' })).body;
      expect(withWecom.wecom).toMatchObject({ botId: 'bot1', secretHint: '已设置（…9876）' });
      expect(JSON.parse(readFileSync(files.bot, 'utf8'))).toMatchObject({
        model: 'claude-sonnet-5-5',
        wecom: { secret: 'wecom-secret-9876' },
      });
      expect((await admin.post('/admin/config/wecom/remove')).body.wecom).toBeNull();
      expect(JSON.parse(readFileSync(files.bot, 'utf8'))).not.toHaveProperty('wecom');

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

      const log = (await admin.get('/admin/audit')).body.map((a: { detail: string }) => a.detail).join('\n');
      expect(log).toContain('更换了 API key');
      expect(log).not.toContain('secret');
    } finally {
      env.db.close();
      rmSync(files.dir, { recursive: true, force: true });
    }
  });
});
