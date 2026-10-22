import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createAiMarket, ensureBots, placeAiBet, resolveAiMarket, type BotDeps } from '../src/bots/agent';
import { loadBotConfig, type BotConfig } from '../src/bots/config';
import { createAsk, createChat, normalizeEndpoint, type Ask, type AskRequest } from '../src/bots/llm';
import { startBots } from '../src/bots/scheduler';
import { getMarketRow } from '../src/services/markets';
import { chatTools } from '../src/wecom/tools';
import { setup } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const BOT: BotConfig = {
  endpoint: 'https://api.anthropic.com',
  apiKey: 'test',
  model: 'claude-opus-5-5',
  bots: 5,
  marketsPerDay: 4,
  betsPerDay: 50,
  flipProbability: 0,
  werewolf: { players: 9, restMinutes: 10 },
};

/** A fake model: answers each submit tool from `answers`, and records what it was asked. */
function fakeAsk(answers: Record<string, unknown | (() => unknown)>) {
  const calls: AskRequest[] = [];
  const ask: Ask = async (req) => {
    calls.push(req);
    const a = answers[req.tool.name];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? (a as () => unknown)() : a;
  };
  return { ask, calls };
}

async function botEnv(answers: Record<string, unknown>, bot: Partial<BotConfig> = {}) {
  const env = setup();
  const fake = fakeAsk(answers);
  const deps: BotDeps = {
    db: env.db,
    config: env.config,
    bot: { ...BOT, ...bot },
    ask: fake.ask,
    now: () => env.clock.now,
  };
  const botIds = await ensureBots(deps);
  return { env, deps, botIds, calls: fake.calls };
}

const marketAnswer = (env: ReturnType<typeof setup>, extra: object = {}) => ({
  question: '周日的比赛主队会赢吗？',
  description: '以官方赛果为准，加时赛计入。',
  category: '体育',
  outcomes: ['是', '否'],
  closeAt: new Date(env.clock.now + 2 * DAY).toISOString(),
  ...extra,
});

describe('AI bots', () => {
  it('creates bot accounts once; bots cannot log in and stay off the leaderboard', async () => {
    const { env, deps, botIds } = await botEnv({});
    expect(botIds).toHaveLength(5);
    expect(await ensureBots(deps)).toEqual(botIds);

    const human = await env.register('alice');
    const board = (await human.get('/leaderboard')).body;
    expect(board.map((e: any) => e.user.username)).toEqual(['alice']);
    expect((await human.get('/stats')).body.users).toBe(1);
    const profile = (await human.get(`/users/${botIds[0]}`)).body;
    expect(profile).toMatchObject({ rank: null, user: { isBot: true, displayName: '🤖 理性水獭' } });
    expect(profile.stats.balance).toBe(1000);

    const anon = env.client();
    expect((await anon.post('/auth/login', { username: 'ai_bot_01', password: 'whatever' })).status).toBe(401);
    expect(
      (await anon.post('/auth/register', { username: 'ai_bot_99', displayName: 'x', password: 'secret123' })).status,
    ).toBe(409);
  });

  it('writes AI markets that only appear in the AI zone', async () => {
    const { env, deps, botIds, calls } = await botEnv({});
    const answers = { submit_market: marketAnswer(env) };
    const id = await createAiMarket({ ...deps, ask: fakeAsk(answers).ask }, botIds[0]!);
    expect(id).not.toBeNull();
    expect(calls).toHaveLength(0);

    const c = env.client();
    expect((await c.get('/markets')).body).toHaveLength(0);
    const ai = (await c.get('/markets?zone=ai')).body;
    expect(ai).toMatchObject([{ id, isAi: true, question: '周日的比赛主队会赢吗？' }]);
    expect((await c.get('/config')).body.aiZone).toBe(true);

    // Out-of-range close times, bad categories and duplicates are rejected.
    const bad = [
      marketAnswer(env, { closeAt: new Date(env.clock.now + 60 * DAY).toISOString() }),
      marketAnswer(env, { category: '八卦' }),
      marketAnswer(env),
    ];
    for (const answer of bad) {
      expect(await createAiMarket({ ...deps, ask: fakeAsk({ submit_market: answer }).ask }, botIds[0]!)).toBeNull();
    }
    expect(await createAiMarket({ ...deps, ask: fakeAsk({ submit_market: new Error('boom') }).ask }, 1)).toBeNull();
  });

  it('bets with one search, must bet, can flip, and falls back to a random bet', async () => {
    const { env, deps, botIds } = await botEnv({});
    const marketId = (await createAiMarket(
      { ...deps, ask: fakeAsk({ submit_market: marketAnswer(env) }).ask },
      botIds[0]!,
    ))!;
    const [yes, no] = (await env.client().get(`/markets/${marketId}`)).body.market.outcomes.map((o: any) => o.id);

    const straight = fakeAsk({ submit_bet: { option: '否', amount: 120, reason: '主队伤病多' } });
    const b1 = await placeAiBet({ ...deps, ask: straight.ask }, botIds[1]!, marketId);
    expect(b1).toEqual({ outcomeId: no, amount: 120, source: 'ai', flipped: false });
    expect(straight.calls[0]!.maxSearches).toBe(1);
    expect(straight.calls[0]!.prompt).toContain('你的余额是 1100'); // daily bonus claimed first

    const flipped = await placeAiBet(
      {
        ...deps,
        bot: { ...BOT, flipProbability: 1 },
        ask: fakeAsk({ submit_bet: { option: '「否」', amount: 30 } }).ask,
      },
      botIds[2]!,
      marketId,
    );
    expect(flipped).toMatchObject({ outcomeId: yes, amount: 30, source: 'ai', flipped: true });

    // Too much is capped at the balance; an unusable or failed answer still bets.
    expect(
      await placeAiBet(
        { ...deps, ask: fakeAsk({ submit_bet: { option: '是', amount: 1e9 } }).ask },
        botIds[3]!,
        marketId,
      ),
    ).toMatchObject({ amount: 1100, source: 'ai' });
    const guess = await placeAiBet(
      { ...deps, ask: fakeAsk({ submit_bet: new Error('timeout') }).ask, random: () => 0.5 },
      botIds[4]!,
      marketId,
    );
    expect(guess).toMatchObject({ source: 'random' });
    expect(guess!.amount).toBeGreaterThan(0);
    const bets = (await env.client().get(`/markets/${marketId}/bets`)).body;
    expect(bets).toHaveLength(4);
  });

  it('keeps bots out of human markets but lets people bet on AI markets', async () => {
    const { env, deps, botIds } = await botEnv({});
    const alice = await env.register('alice');
    const human = await alice.post('/markets', {
      question: '周五团建会下雨吗？',
      category: '生活',
      closeAt: env.clock.now + 2 * DAY,
      outcomes: ['是', '否'],
    });
    await expect(
      placeAiBet(
        { ...deps, ask: fakeAsk({ submit_bet: { option: '是', amount: 10 } }).ask },
        botIds[0]!,
        human.body.id,
      ),
    ).rejects.toThrow('机器人只能在 AI 专区下注');

    const aiId = (await createAiMarket(
      { ...deps, ask: fakeAsk({ submit_market: marketAnswer(env) }).ask },
      botIds[0]!,
    ))!;
    const yes = (await alice.get(`/markets/${aiId}`)).body.market.outcomes[0].id;
    expect((await alice.post(`/markets/${aiId}/bets`, { outcomeId: yes, amount: 50 })).status).toBe(200);
    expect((await alice.get('/activity')).body).toHaveLength(0);
    expect((await alice.get('/activity?zone=ai')).body).toHaveLength(1);
  });

  it('the creator bot settles after close: resolves, waits on unknown, or cancels', async () => {
    const { env, deps, botIds } = await botEnv({});
    const alice = await env.register('alice');
    const open = async () =>
      (await createAiMarket(
        {
          ...deps,
          ask: fakeAsk({ submit_market: marketAnswer(env, { question: `第 ${Math.random()} 场主队会赢吗？` }) }).ask,
        },
        botIds[0]!,
      ))!;

    const first = await open();
    const [yes, no] = (await alice.get(`/markets/${first}`)).body.market.outcomes.map((o: any) => o.id);
    await alice.post(`/markets/${first}/bets`, { outcomeId: yes, amount: 100 });
    await placeAiBet({ ...deps, ask: fakeAsk({ submit_bet: { option: '否', amount: 300 } }).ask }, botIds[1]!, first);
    env.clock.now += 3 * DAY;

    const unknown = fakeAsk({ submit_result: { result: 'unknown', note: '还没公布' } });
    expect(await resolveAiMarket({ ...deps, ask: unknown.ask }, getMarketRow(env.db, first))).toBe('unknown');
    expect(unknown.calls[0]!.maxSearches).toBeGreaterThan(1);
    expect(getMarketRow(env.db, first)).toMatchObject({ status: 'open', ai_checked_at: env.clock.now });

    const win = fakeAsk({ submit_result: { result: '是', note: '主队 2:1 获胜（官网）' } });
    expect(await resolveAiMarket({ ...deps, ask: win.ask }, getMarketRow(env.db, first))).toBe('resolved');
    const market = (await alice.get(`/markets/${first}`)).body.market;
    expect(market).toMatchObject({
      status: 'resolved',
      resolvedOutcomeId: yes,
      resolutionNote: '主队 2:1 获胜（官网）',
    });
    expect((await alice.get('/auth/me')).body.user.balance).toBe(1300); // took the bot's 300
    expect(no).toBeDefined();

    const second = await open();
    env.clock.now += 3 * DAY;
    const cancel = fakeAsk({ submit_result: { result: 'cancel', note: '比赛取消' } });
    expect(await resolveAiMarket({ ...deps, ask: cancel.ask }, getMarketRow(env.db, second))).toBe('cancelled');

    const zone = (await alice.get('/ai')).body;
    expect(zone).toMatchObject({ bots: 5, humanProfit: 300 });
    expect(zone.richestBots).toHaveLength(5);
  });

  it('caps question writing per day, counting failed attempts too', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 0, 1, 4) });
    try {
      const { env, deps, botIds, calls } = await botEnv(
        { submit_market: { question: 'not a valid answer' } },
        { marketsPerDay: 2, betsPerDay: 0 },
      );
      const stop = startBots({ ...deps, now: () => Date.now(), log: () => {} }, botIds);
      await vi.advanceTimersByTimeAsync(5 * HOUR);
      const writes = () => calls.filter((c) => c.tool.name === 'submit_market').length;
      expect(writes()).toBe(2);
      await vi.advanceTimersByTimeAsync(15 * HOUR);
      expect(writes()).toBe(2);
      await vi.advanceTimersByTimeAsync(10 * HOUR); // the first attempts are now over a day old
      expect(writes()).toBe(4);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM bot_attempts').get() as { n: number }).n).toBe(4);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads bot.json and talks to the Messages API with web search, resuming paused turns', async () => {
    expect(normalizeEndpoint('https://relay.example.com/v1/messages/')).toBe('https://relay.example.com');
    expect(loadBotConfig('/nonexistent/bot.json')).toBeNull();

    const requests: any[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const json = JSON.parse(body);
        requests.push({ url: req.url, key: req.headers['x-api-key'], body: json });
        const chatting = json.tools.some((t: { name: string }) => t.name === 'list_markets');
        const content = chatting
          ? [{ type: 'text', text: '你好' }]
          : requests.length === 1
            ? [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }]
            : [{ type: 'tool_use', id: 'tu_1', name: 'submit_bet', input: { option: '是', amount: 12 } }];
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: `msg_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: json.model,
            content,
            stop_reason: chatting ? 'end_turn' : requests.length === 1 ? 'pause_turn' : 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const ask = createAsk({ ...BOT, endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test' });
      const tool = { name: 'submit_bet', description: 'd', input_schema: { type: 'object' as const, properties: {} } };
      expect(await ask({ system: 's', prompt: 'p', maxSearches: 1, tool })).toEqual({ option: '是', amount: 12 });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ url: '/v1/messages?beta=true', key: 'sk-test' });
      expect(requests[0].body.tools[0]).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 1 });
      expect(requests[0].body.fallbacks).toBeUndefined(); // custom endpoint: no refusal fallback by default
      expect(requests[1].body.messages.at(-1)).toMatchObject({ role: 'assistant' }); // paused turn sent back

      // The WeCom chat uses the same model and key with its own client tools and no web search.
      const chat = createChat({ ...BOT, endpoint: `http://127.0.0.1:${port}`, apiKey: 'sk-test' });
      const reply = await chat({ system: 's', messages: [{ role: 'user', content: '你好' }], tools: chatTools });
      expect(reply).toMatchObject({ content: [{ type: 'text', text: '你好' }], stop_reason: 'end_turn' });
      expect(requests[2].body.model).toBe(BOT.model);
      expect(requests[2].body.tools.map((t: { name: string }) => t.name)).not.toContain('web_search');
    } finally {
      server.close();
    }
  });
});
