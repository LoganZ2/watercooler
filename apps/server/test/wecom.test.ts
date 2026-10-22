import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBotConfig } from '../src/bots/config';
import type { Chat, ChatRequest } from '../src/bots/llm';
import { getUserById } from '../src/services/users';
import { createBindToken } from '../src/wecom/bindings';
import { startWecom, stripMentions, type WecomService, type WecomSettings } from '../src/wecom/bot';
import { sendNotices } from '../src/wecom/notifier';
import {
  parseCardClick,
  type Card,
  type CardClick,
  type IncomingText,
  type WecomTransport,
} from '../src/wecom/transport';
import { fixedRuntime, setup } from './helpers';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const SETTINGS: WecomSettings = {
  botId: 'bot',
  secret: 'secret',
  siteUrl: 'https://example.com/watercooler/',
  siteName: 'Watercooler',
  messagesPerHour: 30,
};

/** Stands in for the WeCom connection: delivers messages and clicks, and records what the bot sends. */
function fakeTransport() {
  let onText: (msg: IncomingText) => void = () => {};
  let onClick: (click: CardClick) => void = () => {};
  const sent: { chatId: string; text: string }[] = [];
  const transport: WecomTransport = {
    onText: (h) => {
      onText = h;
    },
    onCardClick: (h) => {
      onClick = h;
    },
    send: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    ready: () => true,
    close: () => {},
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  async function message(userId: string, text: string, chatId: string | null = 'group1') {
    const frames: { content: string; finish: boolean }[] = [];
    const cards: Card[] = [];
    onText({
      userId,
      chatId,
      text,
      reply: async (content, finish) => {
        frames.push({ content, finish });
      },
      replyCard: async (card) => {
        cards.push(card);
      },
    });
    await settle();
    const last = frames.at(-1);
    return { frames, reply: last?.finish ? last.content : undefined, card: cards[0] };
  }

  /** Tap a card button (0 = 确认, 1 = 取消). */
  async function click(userId: string, card: Card, button = 0) {
    const updates: { card: Card; onlyFor?: string[] }[] = [];
    onClick({
      userId,
      chatId: 'group1',
      key: card.button_list![button]!.key,
      taskId: card.task_id!,
      update: async (c, onlyFor) => {
        updates.push({ card: c, onlyFor });
      },
    });
    await settle();
    return updates;
  }

  return { transport, sent, message, click };
}

type Reply = Awaited<ReturnType<Chat>>;

/** A scripted model: each call takes the next step and records the request it got. */
function fakeChat() {
  const steps: ((req: ChatRequest) => Reply)[] = [];
  const requests: ChatRequest[] = [];
  const chat: Chat = async (req) => {
    requests.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
    const step = steps.shift();
    if (!step) throw new Error('unexpected model call');
    return step(req);
  };
  return { chat, requests, script: (...s: ((req: ChatRequest) => Reply)[]) => steps.push(...s) };
}

const callTools =
  (...calls: [string, object][]) =>
  (): Reply =>
    ({
      content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `call_${name}_${i}`, name, input })),
      stop_reason: 'tool_use',
    }) as unknown as Reply;
const callTool = (name: string, input: object) => callTools([name, input]);
const answer = (text: string) => (): Reply =>
  ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) as unknown as Reply;

/** The tool results the bot sent back on the last model call. */
const toolResults = (req: ChatRequest) =>
  (req.messages.at(-1)!.content as { content: string; is_error: boolean }[]).map((r) => ({
    content: r.content,
    isError: r.is_error,
  }));

let services: WecomService[] = [];
afterEach(() => {
  for (const s of services) s.stop();
  services = [];
});

function wecomEnv(settings: Partial<WecomSettings> = {}) {
  const fake = fakeTransport();
  const model = fakeChat();
  const env = setup({}, (base) => {
    const service = startWecom({
      ...base,
      settings: { ...SETTINGS, ...settings },
      chat: model.chat,
      transport: fake.transport,
      log: () => {},
    });
    services.push(service);
    return { runtime: fixedRuntime({ wecom: service }) };
  });
  const notices = () =>
    sendNotices({
      db: env.db,
      transport: fake.transport,
      siteUrl: 'https://example.com/watercooler',
      now: () => env.clock.now,
      log: () => {},
    });

  /** Register a site account and bind it to a WeCom user through the link the bot hands out. */
  async function bind(username: string, wecomUserId: string, chatId = 'group1') {
    const client = await env.register(username);
    const { reply } = await fake.message(wecomUserId, '@小助手 在吗', chatId);
    const token = /\/bind\/([\w-]+)\)/.exec(reply ?? '')![1]!;
    expect((await client.post('/wecom/bind', { token })).status).toBe(200);
    return client;
  }

  async function market(client: Awaited<ReturnType<typeof env.register>>, question = '周五的团建会下雨吗？') {
    const res = await client.post('/markets', {
      question,
      description: '以气象台为准',
      category: '公司',
      closeAt: env.clock.now + 2 * DAY,
      outcomes: ['是', '否'],
    });
    return res.body.id as number;
  }

  return { env, fake, model, notices, bind, market };
}

describe('WeCom bot', () => {
  it('refuses one-on-one chats and answers unbound people with a binding link, never the model', async () => {
    const { fake, model } = wecomEnv();
    const single = await fake.message('zhangsan', '有什么盘', null);
    expect(single.reply).toContain('私聊不支持');

    const group = await fake.message('zhangsan', '@小助手 有什么盘');
    expect(group.reply).toMatch(/\[点这里绑定\]\(https:\/\/example\.com\/watercooler\/bind\/[\w-]{32}\)/);
    expect(group.reply).not.toContain('zhangsan'); // WeCom userids are encrypted; never shown
    expect(model.requests).toHaveLength(0);
  });

  it('binds through the link once, announces it in the group, and can be undone', async () => {
    const { env, fake } = wecomEnv();
    const alice = await env.register('alice');
    expect((await alice.get('/config')).body.wecom).toBe(true);
    const { reply } = await fake.message('zhangsan', '@小助手 你好');
    const token = /\/bind\/([\w-]+)\)/.exec(reply!)![1]!;

    expect((await env.client().get(`/wecom/bind/${token}`)).status).toBe(401);
    const info = await alice.get(`/wecom/bind/${token}`);
    expect(info.body).toMatchObject({ wecomUserId: 'zhangsan', current: null });

    const bound = await alice.post('/wecom/bind', { token });
    expect(bound.body).toMatchObject({ wecomUserId: 'zhangsan' });
    expect(fake.sent).toEqual([{ chatId: 'group1', text: '✅ ALICE 绑定成功' }]);
    expect((await alice.post('/wecom/bind', { token })).status).toBe(404);
    expect((await alice.get('/me/wecom')).body.binding).toMatchObject({ wecomUserId: 'zhangsan' });

    // A WeCom account already bound elsewhere cannot be taken over by a second link.
    const bob = await env.register('bob');
    const second = createBindToken(env.db, 'zhangsan', 'group1', env.clock.now);
    expect((await bob.post('/wecom/bind', { token: second })).status).toBe(409);

    // Expired links stop working.
    const late = createBindToken(env.db, 'lisi', 'group1', env.clock.now);
    env.clock.now += 11 * MINUTE;
    expect((await bob.get(`/wecom/bind/${late}`)).status).toBe(404);

    expect((await alice.post('/me/wecom/unbind')).status).toBe(200);
    expect((await alice.get('/me/wecom')).body.binding).toBeNull();
  });

  it('answers bound people with the model and read-only tools, remembering the conversation', async () => {
    const { fake, model, bind, market } = wecomEnv();
    const alice = await bind('alice', 'zhangsan');
    await market(alice);

    model.script(callTool('list_markets', {}), answer('现在有一个盘：周五的团建会下雨吗？'));
    const first = await fake.message('zhangsan', '@小助手 现在有什么盘');
    expect(first.frames.slice(0, 2)).toEqual([
      { content: '思考中…', finish: false },
      { content: '思考中…（查市场）', finish: false },
    ]);
    expect(first.reply).toBe('现在有一个盘：周五的团建会下雨吗？');
    expect(model.requests[0]!.system).toContain('ALICE');
    expect(model.requests[0]!.messages).toEqual([{ role: 'user', content: '现在有什么盘' }]);
    const [listed] = toolResults(model.requests[1]!);
    expect(listed!.isError).toBe(false);
    expect(JSON.parse(listed!.content)[0]).toMatchObject({ question: '周五的团建会下雨吗？', status: '可下注' });

    model.script(callTool('my_account', {}), answer('你有 1000 水滴'));
    await fake.message('zhangsan', '@小助手 我还有多少钱');
    expect(model.requests[2]!.messages.slice(0, 2)).toEqual([
      { role: 'user', content: '现在有什么盘' },
      { role: 'assistant', content: '现在有一个盘：周五的团建会下雨吗？' },
    ]);
    expect(JSON.parse(toolResults(model.requests[3]!)[0]!.content)).toMatchObject({ balance: 1000, rank: 1 });
  });

  it('bets only after the owner confirms the card', async () => {
    const { env, fake, model, bind, market } = wecomEnv();
    const alice = await bind('alice', 'zhangsan');
    await bind('bob', 'lisi');
    const id = await market(alice);
    const bobId = (await alice.get('/leaderboard')).body.find((e: any) => e.user.username === 'bob').user.id;
    const balance = () => getUserById(env.db, bobId)!.balance / 100;

    model.script(callTool('place_bet', { marketId: id, outcome: '是', amount: 100 }), answer('请点卡片确认'));
    const { reply, card } = await fake.message('lisi', '@小助手 周五下雨押 100 是');
    expect(reply).toBe('请点卡片确认');
    expect(card).toMatchObject({ card_type: 'button_interaction', main_title: { title: '确认下注 100 水滴' } });
    expect(card!.horizontal_content_list).toContainEqual({ keyname: '选项', value: '是' });
    expect(balance()).toBe(1000);

    const stranger = await fake.click('zhangsan', card!);
    expect(stranger).toEqual([{ card: expect.objectContaining({ card_type: 'text_notice' }), onlyFor: ['zhangsan'] }]);
    expect(stranger[0]!.card.main_title!.title).toBe('只有BOB本人可以确认');
    expect(balance()).toBe(1000);

    const confirmed = await fake.click('lisi', card!);
    expect(confirmed).toEqual([
      {
        card: expect.objectContaining({ main_title: { title: '✅ 下注成功' }, task_id: card!.task_id }),
        onlyFor: undefined,
      },
    ]);
    expect(balance()).toBe(900);
    expect((await alice.get(`/markets/${id}`)).body.market.pot).toBe(100);

    const again = await fake.click('lisi', card!);
    expect(again[0]!.card.main_title!.title).toBe('这个操作已经处理过了');
    expect(balance()).toBe(900);
  });

  it('allows one card per message and does nothing for cancelled or expired cards', async () => {
    const { env, fake, model, bind, market } = wecomEnv();
    const alice = await bind('alice', 'zhangsan');
    const id = await market(alice);
    const pot = async () => (await alice.get(`/markets/${id}`)).body.market.pot;

    model.script(
      callTools(
        ['place_bet', { marketId: id, outcome: '是', amount: 10 }],
        ['place_bet', { marketId: id, outcome: '否', amount: 10 }],
      ),
      answer('先确认第一个'),
    );
    const { card } = await fake.message('zhangsan', '@小助手 两边各押 10');
    expect(toolResults(model.requests[1]!).map((r) => r.isError)).toEqual([false, true]);
    const cancelled = await fake.click('zhangsan', card!, 1);
    expect(cancelled[0]!.card.main_title!.title).toBe('已取消');
    expect(await pot()).toBe(0);

    model.script(callTool('place_bet', { marketId: id, outcome: '是', amount: 10 }), answer('请确认'));
    const late = await fake.message('zhangsan', '@小助手 押 10 是');
    env.clock.now += 11 * MINUTE;
    expect((await fake.click('zhangsan', late.card!))[0]!.card.main_title!.title).toBe('确认卡片已过期');
    expect(await pot()).toBe(0);

    // Problems are caught before a card is made: the model is told why and no card goes out.
    model.script(callTool('place_bet', { marketId: id, outcome: '也许', amount: 5000 }), answer('没有这个选项'));
    const bad = await fake.message('zhangsan', '@小助手 押 5000 也许');
    expect(bad.card).toBeUndefined();
    expect(toolResults(model.requests.at(-1)!)[0]).toMatchObject({ isError: true });
  });

  it('opens and settles markets through cards, then reminds and reports in each group', async () => {
    const { env, fake, model, bind, notices } = wecomEnv();
    const alice = await bind('alice', 'zhangsan', 'group1');
    const bob = await bind('bob', 'lisi', 'group2');

    model.script(
      callTool('create_market', {
        question: '下周一会发年终奖吗？',
        description: '以 HR 邮件为准',
        category: '公司',
        closeAt: new Date(env.clock.now + 2 * DAY).toISOString().replace('Z', '+00:00'),
        outcomes: ['会', '不会'],
      }),
      answer('请确认开盘'),
    );
    const created = await fake.message('zhangsan', '@小助手 开个盘：下周一会发年终奖吗');
    expect(created.card!.main_title).toMatchObject({ title: '确认开盘' });
    const opened = await fake.click('zhangsan', created.card!);
    expect(opened[0]!.card.main_title!.title).toBe('✅ 开盘成功');
    const [m] = (await alice.get('/markets')).body;
    expect(m).toMatchObject({ question: '下周一会发年终奖吗？', creator: { username: 'alice' } });

    const [yes, no] = m.outcomes;
    await bob.post(`/markets/${m.id}/bets`, { outcomeId: yes.id, amount: 100 });
    await alice.post(`/markets/${m.id}/bets`, { outcomeId: no.id, amount: 50 });

    // Someone else's market cannot be resolved from chat.
    model.script(callTool('resolve_market', { marketId: m.id, outcome: '会' }), answer('不是你的盘'));
    await fake.message('lisi', '@小助手 年终奖那个盘结果是会', 'group2');
    expect(toolResults(model.requests.at(-1)!)[0]!.content).toContain('只有市场创建者');

    env.clock.now += 2 * DAY + MINUTE;
    await notices();
    expect(fake.sent.at(-1)).toEqual({
      chatId: 'group1',
      text: expect.stringContaining('已经截止下注，可以公布结果了'),
    });
    const count = fake.sent.length;
    await notices();
    expect(fake.sent).toHaveLength(count);

    model.script(
      callTool('resolve_market', { marketId: m.id, outcome: '会', note: 'HR 发邮件了' }),
      answer('请确认结果'),
    );
    const resolving = await fake.message('zhangsan', '@小助手 年终奖发了，结果是会');
    expect((await fake.click('zhangsan', resolving.card!))[0]!.card.main_title!.title).toBe('✅ 已公布结果并结算');
    expect((await bob.get('/auth/me')).body.user.balance).toBe(1050);

    await notices();
    const reports = fake.sent.slice(count);
    expect(reports.map((r) => r.chatId).sort()).toEqual(['group1', 'group2']);
    expect(reports.find((r) => r.chatId === 'group2')!.text).toContain('BOB：押 100，拿回 150（+50）');
    expect(reports.find((r) => r.chatId === 'group1')!.text).toContain('ALICE：押 50，没押中（-50）');
    expect(reports[0]!.text).toContain('公布结果：**会**');
    await notices();
    expect(fake.sent).toHaveLength(count + 2);
  });

  it('uses share holders and fixed redemption rules on Polymarket resolution cards', async () => {
    const { env, fake, model, bind } = wecomEnv();
    const alice = await bind('alice', 'zhangsan');
    const bob = await env.register('bob');
    const carol = await env.register('carol');
    const created = await alice.post('/markets', {
      question: '份额市场确认卡片是否正确？',
      category: '生活',
      mode: 'polymarket',
      closeAt: env.clock.now + DAY,
      outcomes: ['Yes', 'No'],
    });
    expect(created.status).toBe(201);
    const base = `/markets/${created.body.id}`;
    const yes = (await alice.get(base)).body.market.outcomes[0].id;
    const order = (client: typeof alice, side: 'buy' | 'sell', price: number, quantity: number) =>
      client.post(`${base}/orders`, { outcomeId: yes, side, price, quantity });
    await alice.post(`${base}/split`, { quantity: 10 });
    await order(alice, 'sell', 0.6, 4);
    await order(bob, 'buy', 0.6, 4);
    await order(bob, 'sell', 0.7, 1);
    await order(carol, 'buy', 0.7, 1);
    await order(carol, 'sell', 0.7, 1);
    await order(bob, 'buy', 0.7, 1);
    // The zero-quantity row left by Carol's sale must not be counted as a winner.
    expect(
      env.db.prepare('SELECT quantity FROM exchange_positions WHERE user_id = 3 AND outcome_id = ?').get(yes),
    ).toEqual({ quantity: 0 });
    env.clock.now += DAY;
    model.script(callTool('resolve_market', { marketId: created.body.id, outcome: 'Yes' }), answer('请确认结果'));
    const resolving = await fake.message('zhangsan', '@小助手 结果是 Yes');
    expect(resolving.card!.horizontal_content_list).toEqual([
      { keyname: '结果', value: 'Yes' },
      { keyname: '抵押资金', value: '10 水滴' },
      { keyname: '获胜持有人', value: '2' },
      { keyname: '兑付规则', value: '获胜每份兑回 1 水滴，落败每份兑回 0' },
    ]);
    expect(JSON.stringify(resolving.card)).not.toContain('全部退还');
    expect((await alice.get(base)).body.market.status).toBe('closed');
    expect((await alice.get('/auth/me')).body.user.balance).toBe(992.4);
    expect((await fake.click('zhangsan', resolving.card!))[0]!.card.main_title!.title).toBe('✅ 已公布结果并结算');
    expect((await alice.get('/auth/me')).body.user.balance).toBe(998.4);
    expect((await bob.get('/auth/me')).body.user.balance).toBe(1001.6);
    expect((await carol.get('/auth/me')).body.user.balance).toBe(1000);

    // An empty exchange has zero winning holders, and still never promises a pool-style refund.
    const empty = await alice.post('/markets', {
      question: '没有份额的市场确认卡片？',
      category: '生活',
      mode: 'polymarket',
      closeAt: env.clock.now + DAY,
      outcomes: ['Yes', 'No'],
    });
    env.clock.now += DAY;
    model.script(callTool('resolve_market', { marketId: empty.body.id, outcome: 'No' }), answer('请确认结果'));
    const emptyCard = (await fake.message('zhangsan', '@小助手 空市场结果是 No')).card!;
    expect(emptyCard.horizontal_content_list).toContainEqual({ keyname: '获胜持有人', value: '0' });
    expect(JSON.stringify(emptyCard)).not.toContain('全部退还');

    // Pool mode retains the full-refund rule when nobody backed the winning outcome.
    const pool = await alice.post('/markets', {
      question: '没人押中的奖池仍然全额退还？',
      category: '生活',
      closeAt: env.clock.now + DAY,
      outcomes: ['是', '否'],
    });
    expect(pool.status).toBe(201);
    const poolBase = `/markets/${pool.body.id}`;
    const poolMarket = (await alice.get(poolBase)).body.market;
    await bob.post(`${poolBase}/bets`, { outcomeId: poolMarket.outcomes[1].id, amount: 10 });
    env.clock.now += DAY;
    model.script(callTool('resolve_market', { marketId: pool.body.id, outcome: '是' }), answer('请确认结果'));
    const poolCard = (await fake.message('zhangsan', '@小助手 奖池结果是 是')).card!;
    expect(poolCard.horizontal_content_list).toContainEqual({ keyname: '押中人数', value: '没人押中，全部退还' });
    expect(JSON.stringify(poolCard)).not.toContain('兑付规则');
    expect((await fake.click('zhangsan', poolCard))[0]!.card.main_title!.title).toBe('✅ 已公布结果并结算');
    expect((await bob.get('/auth/me')).body.user.balance).toBe(1001.6);
  });

  it('lets pool creators announce early, holds Polymarket until settleAt, and reports share payouts', async () => {
    const { env, fake, model, bind, notices } = wecomEnv();
    const alice = await bind('alice', 'zhangsan');
    const bob = await bind('bob', 'lisi', 'group2');
    const closeAt = env.clock.now + DAY;
    const create = async (mode: string) =>
      (
        await alice.post('/markets', {
          question: `${mode} 下周会发年终奖吗？`,
          category: '公司',
          mode,
          closeAt,
          outcomes: ['Yes', 'No'],
        })
      ).body.id as number;
    const pool = await create('pool');
    const poly = await create('polymarket');
    const [yes] = (await alice.get(`/markets/${poly}`)).body.market.outcomes;
    expect((await bob.post(`/markets/${poly}/split`, { quantity: 10 })).status).toBe(200);
    await bob.post(`/markets/${poly}/orders`, { outcomeId: yes.id, side: 'sell', price: 0.9, quantity: 2 });

    model.script(callTool('my_account', {}), answer('你有 10 份 Yes'));
    await fake.message('lisi', '@小助手 我的持仓', 'group2');
    const account = JSON.parse(toolResults(model.requests.at(-1)!)[0]!.content);
    expect(account.polymarketPositions).toContainEqual(
      expect.objectContaining({ marketId: poly, share: 'Yes', shares: 10, reservedForSale: 2, avgPrice: 0.5 }),
    );
    expect(account.polymarketOpenOrders).toEqual([
      expect.objectContaining({
        question: 'polymarket 下周会发年终奖吗？',
        share: 'Yes',
        side: '卖出',
        price: 0.9,
        remaining: 2,
      }),
    ]);

    // Before the settlement time a Polymarket card could only fail, so none is made.
    model.script(callTool('resolve_market', { marketId: poly, outcome: 'Yes' }), answer('还不能公布'));
    expect((await fake.message('zhangsan', '@小助手 polymarket 那个结果是 Yes')).card).toBeUndefined();
    expect(toolResults(model.requests.at(-1)!)[0]).toMatchObject({ isError: true });
    expect(toolResults(model.requests.at(-1)!)[0]!.content).toContain('之后才能公布');

    // A pool market can be announced before it closes.
    model.script(callTool('resolve_market', { marketId: pool, outcome: 'Yes' }), answer('请确认'));
    const early = await fake.message('zhangsan', '@小助手 pool 那个已经确定是 Yes 了');
    expect(early.card!.sub_title_text).toContain('提前结束下注');
    expect((await fake.click('zhangsan', early.card!))[0]!.card.main_title!.title).toBe('✅ 已公布结果并结算');

    env.clock.now = closeAt + 1;
    model.script(callTool('resolve_market', { marketId: poly, outcome: 'Yes' }), answer('请确认'));
    const resolving = await fake.message('zhangsan', '@小助手 polymarket 那个结果是 Yes');
    expect((await fake.click('zhangsan', resolving.card!))[0]!.card.main_title!.title).toBe('✅ 已公布结果并结算');
    expect((await bob.get('/auth/me')).body.user.balance).toBe(1000);

    await notices();
    expect(fake.sent.filter((m) => m.chatId === 'group2').at(-1)!.text).toContain('BOB：兑回 10');
  });

  it('reminds at settlement time and only warns pool markets about automatic refunds', async () => {
    const { env, fake, bind, notices } = wecomEnv();
    const alice = await bind('alice', 'zhangsan');
    const closeAt = env.clock.now + DAY;
    const settleAt = closeAt + 10 * DAY;
    const paths: string[] = [];
    for (const mode of ['pool', 'polymarket']) {
      const created = await alice.post('/markets', {
        question: `${mode} 延迟公布结果的预测？`,
        category: '生活',
        mode,
        closeAt,
        settleAt,
        outcomes: ['Yes', 'No'],
      });
      expect(created.status).toBe(201);
      paths.push(`/markets/${created.body.id}`);
    }
    const before = fake.sent.length;
    env.clock.now = closeAt;
    await notices();
    expect(fake.sent).toHaveLength(before);
    env.clock.now = settleAt;
    await notices();
    const reminders = fake.sent.slice(before);
    expect(reminders).toHaveLength(2);
    expect(reminders.find((r) => r.text.includes('「pool '))!.text).toContain('7 天内不公布会自动取消');
    expect(reminders.find((r) => r.text.includes('「polymarket '))!.text).toContain('不会自动取消');
    env.clock.now = settleAt + 6 * DAY;
    await notices();
    expect(fake.sent).toHaveLength(before + 3);
    expect(fake.sent.at(-1)!.text).toContain('「pool ');
    expect(fake.sent.at(-1)!.text).toContain('再过一天');
    env.clock.now = settleAt + 7 * DAY;
    expect((await alice.get(paths[0]!)).body.market.status).toBe('cancelled');
    expect((await alice.get(paths[1]!)).body.market.status).toBe('closed');
  });

  it('unbinds on request and limits how often the model is asked', async () => {
    const { fake, model, bind } = wecomEnv({ messagesPerHour: 1 });
    await bind('alice', 'zhangsan');

    model.script(answer('你好'));
    expect((await fake.message('zhangsan', '@小助手 你好')).reply).toBe('你好');
    expect((await fake.message('zhangsan', '@小助手 再问一次')).reply).toContain('问得有点多');
    expect(model.requests).toHaveLength(1);

    expect((await fake.message('zhangsan', '@小助手 解绑')).reply).toContain('已解除');
    expect((await fake.message('zhangsan', '@小助手 你好')).reply).toContain('/bind/');
  });

  it('reads card clicks the way WeCom sends them', () => {
    const click = { userId: 'u1', chatId: 'g1', key: 'wc_ok_7', taskId: 'wc_x_1' };
    const from = { from: { userid: 'u1' }, chattype: 'group', chatid: 'g1', msgtype: 'event' };
    // What the WeCom server actually sends: the click is nested under template_card_event.
    expect(
      parseCardClick({
        ...from,
        event: {
          eventtype: 'template_card_event',
          template_card_event: { card_type: 'button_interaction', event_key: 'wc_ok_7', task_id: 'wc_x_1' },
        },
      }),
    ).toEqual(click);
    // The flat shape the SDK's types describe.
    expect(
      parseCardClick({ ...from, event: { eventtype: 'template_card_event', event_key: 'wc_ok_7', task_id: 'wc_x_1' } }),
    ).toEqual(click);
    expect(parseCardClick({ ...from, chattype: 'single', event: { event_key: 'k', task_id: 't' } })).toMatchObject({
      chatId: null,
    });
    expect(parseCardClick({ ...from, event: { eventtype: 'template_card_event' } })).toBeNull();
    expect(parseCardClick(undefined)).toBeNull();
  });

  it('reads the wecom section of bot.json and strips mentions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const path = join(dir, 'bot.json');
    writeFileSync(
      path,
      JSON.stringify({ apiKey: 'k', model: 'm', wecom: { botId: 'b', secret: 's', siteUrl: 'https://x.com/wc' } }),
    );
    expect(loadBotConfig(path)!.wecom).toEqual({
      botId: 'b',
      secret: 's',
      siteUrl: 'https://x.com/wc',
      siteName: 'Watercooler',
      messagesPerHour: 30,
    });
    writeFileSync(path, JSON.stringify({ apiKey: 'k', model: 'm', wecom: { botId: 'b' } }));
    expect(() => loadBotConfig(path)).toThrow(/wecom\.secret/);

    expect(stripMentions('@小助手 押 100 是')).toBe('押 100 是');
    expect(stripMentions('  @小助手@张三 你好 @李四')).toBe('你好 @李四');
  });
});
