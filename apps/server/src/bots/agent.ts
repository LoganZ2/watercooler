import { randomBytes } from 'node:crypto';
import {
  CATEGORIES,
  createMarketSchema,
  CURRENCY_NAME,
  fromCents,
  MAX_BET,
  MIN_BET,
  type MarketDetail,
} from '@watercooler/shared';
import { z } from 'zod';
import type { Config } from '../config';
import type { DB } from '../db';
import { DAY, HOUR } from '../lib/time';
import { cancelMarket, placeBet, resolveMarket } from '../services/bets';
import { createMarket, getMarketDetail, listMarkets, type MarketRow } from '../services/markets';
import { BOT_USERNAME_PREFIX, claimDailyBonus, createUser, getUserById } from '../services/users';
import type { BotConfig } from './config';
import type { Ask, SubmitTool } from './llm';

export interface BotDeps {
  db: DB;
  config: Config;
  bot: BotConfig;
  ask: Ask;
  now: () => number;
  random?: () => number;
  log?: (message: string) => void;
}

/** Searches allowed when writing or settling a question (bets get exactly one). */
export const RESEARCH_SEARCHES = 8;
/** AI questions must be settled within this window. */
const MIN_CLOSE = 2 * HOUR;
const MAX_CLOSE = 30 * DAY;
/** How long the creator bot waits before looking up an unknown result again. */
export const RECHECK_AFTER = 12 * HOUR;

const ADJECTIVES = ['理性', '莽撞', '佛系', '谨慎', '乐观', '悲观', '冷静', '冲动', '老练', '天真'];
const ANIMALS = ['水獭', '柴犬', '狐狸', '熊猫', '海豚', '猫头鹰', '仓鼠', '企鹅', '浣熊', '树懒'];

/** 🤖 理性水獭, 🤖 莽撞水獭, … — the robot emoji also becomes the avatar. */
export function botName(i: number): string {
  const name = `${ADJECTIVES[i % 10]}${ANIMALS[Math.floor(i / 10) % 10]}`;
  return `🤖 ${name}${i >= 100 ? Math.floor(i / 100) + 1 : ''}`;
}

/** Create missing bot accounts and return the ids of the first `bot.bots` of them. */
export async function ensureBots(deps: BotDeps): Promise<number[]> {
  const { db, config, bot, now } = deps;
  // Only the accounts made here: other bot accounts (the Polymarket mirror's) are not AI bots.
  const existing = db
    .prepare(`SELECT id FROM users WHERE is_bot = 1 AND username LIKE ? ESCAPE '\\' ORDER BY id`)
    .all(`${BOT_USERNAME_PREFIX.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as { id: number }[];
  for (let i = existing.length; i < bot.bots; i++) {
    const username = `${BOT_USERNAME_PREFIX}${String(i + 1).padStart(2, '0')}`;
    // Bots never log in; the random password just keeps the account unusable.
    const user = await createUser(
      db,
      config,
      { username, displayName: botName(i), password: randomBytes(24).toString('hex') },
      now(),
      { bot: true },
    );
    existing.push({ id: user.id });
  }
  return existing.slice(0, bot.bots).map((u) => u.id);
}

const beijing = (t: number) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(t);

function describeMarket(m: MarketDetail): string {
  const options = m.outcomes
    .map(
      (o, i) => `${i + 1}. 「${o.label}」— 奖池 ${o.pool} ${CURRENCY_NAME}（占 ${Math.round(o.probability * 100)}%）`,
    )
    .join('\n');
  return [
    `题目：${m.question}`,
    `结算规则：${m.description || '（无）'}`,
    `下注截止：${beijing(m.closeAt)}（北京时间）`,
    `选项和当前奖池（总奖池 ${m.pot} ${CURRENCY_NAME}）：`,
    options,
  ].join('\n');
}

// ---------------------------------------------------------------- creating questions

const SUBMIT_MARKET: SubmitTool = {
  name: 'submit_market',
  description: '提交你出的预测题。',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '题目，一句话，5–200 字' },
      description: { type: 'string', description: '结算规则：以什么来源、什么时间、什么数值为准，边界情况怎么算' },
      category: { type: 'string', enum: [...CATEGORIES] },
      outcomes: {
        type: 'array',
        items: { type: 'string' },
        description: '二元题固定为 ["是", "否"]；多选题 3–6 个互斥选项',
      },
      closeAt: { type: 'string', description: '下注截止时间，ISO 8601 带时区，例如 2026-10-25T20:00:00+08:00' },
    },
    required: ['question', 'description', 'category', 'outcomes', 'closeAt'],
    additionalProperties: false,
  },
};

const marketAnswer = z.object({
  question: z.string(),
  description: z.string(),
  category: z.enum(CATEGORIES),
  outcomes: z.array(z.string()).min(2).max(6),
  closeAt: z.string(),
});

/** Have a bot research the news and open a new AI market. Returns the market id, or null. */
export async function createAiMarket(deps: BotDeps, creatorId: number): Promise<number | null> {
  const { db, ask, now, log = () => {} } = deps;
  const existing = listMarkets(db, now(), { zone: 'ai', filter: 'active', limit: 50 }).map((m) => m.question);
  const prompt = [
    `现在是北京时间 ${beijing(now())}。`,
    '请先联网搜索最近的新闻（体育、科技、财经、娱乐、国际都可以），然后出一道新的预测题。要求：',
    `- 结果在 ${MIN_CLOSE / HOUR} 小时到 ${MAX_CLOSE / DAY} 天之内揭晓，到时候能通过公开新闻或数据核实。`,
    '- 题目具体、没有歧义，结算规则写清楚以什么为准（来源、时间、数值）。',
    '- 二元题的选项固定为「是」「否」；多选题给 3–6 个互斥选项，尽量覆盖所有可能，必要时加「其他」。',
    '- 结果不能是现在就已经确定的。',
    existing.length ? `- 不要和这些已有的题目重复：\n${existing.map((q) => `  · ${q}`).join('\n')}` : '',
    '最后必须调用 submit_market 工具提交。',
  ]
    .filter(Boolean)
    .join('\n');

  let answer: unknown;
  try {
    answer = await ask({
      system: '你是一个预测市场的出题人，出的题有意思、结果明确、能按公开信息核实。所有内容用简体中文。',
      prompt,
      maxSearches: RESEARCH_SEARCHES,
      tool: SUBMIT_MARKET,
    });
  } catch (err) {
    log(`create: model call failed: ${(err as Error).message}`);
    return null;
  }
  const parsed = marketAnswer.safeParse(answer);
  if (!parsed.success) {
    log(`create: unusable answer ${JSON.stringify(answer)?.slice(0, 300)}`);
    return null;
  }
  const t = now();
  const closeAt = Date.parse(parsed.data.closeAt);
  if (!Number.isFinite(closeAt) || closeAt < t + MIN_CLOSE || closeAt > t + MAX_CLOSE) {
    log(`create: close time out of range: ${parsed.data.closeAt}`);
    return null;
  }
  const input = createMarketSchema.safeParse({ ...parsed.data, closeAt });
  if (!input.success || existing.includes(input.data.question)) {
    log(`create: rejected ${input.success ? 'duplicate' : input.error.issues[0]?.message}: ${parsed.data.question}`);
    return null;
  }
  const id = createMarket(db, creatorId, input.data, t, { ai: true });
  log(`create: #${id} ${input.data.question}`);
  return id;
}

// ---------------------------------------------------------------- betting

const SUBMIT_BET: SubmitTool = {
  name: 'submit_bet',
  description: '提交你的下注。必须调用，不能弃权。',
  input_schema: {
    type: 'object',
    properties: {
      option: { type: 'string', description: '你押的选项，原样填写选项文字' },
      amount: { type: 'number', description: `下注金额（${CURRENCY_NAME}），由你自己决定` },
      reason: { type: 'string', description: '一句话理由' },
    },
    required: ['option', 'amount', 'reason'],
    additionalProperties: false,
  },
};

const betAnswer = z.object({ option: z.string(), amount: z.number(), reason: z.string().optional() });

export interface BotBet {
  outcomeId: number;
  amount: number;
  /** `ai`: the model picked it; `random`: the model call failed, so the bot guessed. */
  source: 'ai' | 'random';
  flipped: boolean;
}

/**
 * One bot bet: the model gets the question, the pools and a single web search, then must pick an
 * option and an amount. With `flipProbability` the bot then bets on a different option instead.
 */
export async function placeAiBet(deps: BotDeps, botId: number, marketId: number): Promise<BotBet | null> {
  const { db, config, bot, ask, now, log = () => {} } = deps;
  const random = deps.random ?? Math.random;
  if (config.dailyBonus > 0) {
    try {
      claimDailyBonus(db, config, botId, now());
    } catch {
      // already claimed today
    }
  }
  const user = getUserById(db, botId)!;
  const balance = fromCents(user.balance);
  if (balance < MIN_BET) return null;
  const market = getMarketDetail(db, marketId, now());
  const labels = market.outcomes.map((o) => o.label);

  let pick: { index: number; amount: number } | null = null;
  try {
    const answer = betAnswer.safeParse(
      await ask({
        system: `你是预测市场里的下注者「${user.display_name.replace(/^🤖\s*/, '')}」，靠自己查到的信息独立判断，然后下注。`,
        prompt: [
          `现在是北京时间 ${beijing(now())}。你的余额是 ${balance} ${CURRENCY_NAME}。`,
          describeMarket(market),
          '规则：奖池模式，押中的人按下注比例瓜分全部奖池；没人押中则全部退还。',
          '你最多可以联网搜索一次（搜索失败也算用掉）。之后必须调用 submit_bet 下注，不能弃权：',
          `option 原样填写一个选项（${labels.map((l) => `「${l}」`).join('、')}），amount 是 ${MIN_BET} 到 ${Math.min(balance, MAX_BET)} 之间的${CURRENCY_NAME}，押多少由你决定。`,
        ].join('\n\n'),
        maxSearches: 1,
        tool: SUBMIT_BET,
      }),
    );
    const index = answer.success ? labels.indexOf(answer.data.option.trim().replace(/^「|」$/g, '')) : -1;
    if (answer.success && index >= 0 && Number.isFinite(answer.data.amount)) {
      pick = { index, amount: answer.data.amount };
    } else {
      log(`bet: unusable answer for #${marketId}`);
    }
  } catch (err) {
    log(`bet: model call failed: ${(err as Error).message}`);
  }

  const source = pick ? 'ai' : 'random';
  // The bet is mandatory: without a usable answer the bot guesses, staking 2–10% of its balance.
  pick ??= { index: Math.floor(random() * labels.length), amount: balance * (0.02 + random() * 0.08) };
  let index = pick.index;
  const flipped = labels.length > 1 && random() < bot.flipProbability;
  if (flipped) index = (index + 1 + Math.floor(random() * (labels.length - 1))) % labels.length;
  const amount = Math.floor(Math.min(Math.max(pick.amount, MIN_BET), balance, MAX_BET) * 100) / 100;
  const outcomeId = market.outcomes[index]!.id;
  placeBet(db, botId, marketId, { outcomeId, amount }, now());
  log(
    `bet: ${user.display_name} ${amount} on 「${labels[index]}」 #${marketId} (${source}${flipped ? ', flipped' : ''})`,
  );
  return { outcomeId, amount, source, flipped };
}

// ---------------------------------------------------------------- settling

const SUBMIT_RESULT: SubmitTool = {
  name: 'submit_result',
  description: '提交这道题的最终结果。',
  input_schema: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        description: '结果明确时原样填写获胜的选项；还没公布或查不到填 "unknown"；题目有歧义或已无法判定填 "cancel"',
      },
      note: { type: 'string', description: '一两句话说明依据和来源' },
    },
    required: ['result', 'note'],
    additionalProperties: false,
  },
};

const resultAnswer = z.object({ result: z.string(), note: z.string() });

export type Settlement = 'resolved' | 'cancelled' | 'unknown';

/** The creator bot looks up the outcome of a closed AI market and settles it. */
export async function resolveAiMarket(deps: BotDeps, market: MarketRow): Promise<Settlement> {
  const { db, ask, now, log = () => {} } = deps;
  db.prepare('UPDATE markets SET ai_checked_at = ? WHERE id = ?').run(now(), market.id);
  const detail = getMarketDetail(db, market.id, now());
  let answer: z.infer<typeof resultAnswer> | null = null;
  try {
    const parsed = resultAnswer.safeParse(
      await ask({
        system: '你是这道预测题的出题人，现在要根据事实公布结果。必须联网核实，不能猜。所有内容用简体中文。',
        prompt: [
          `现在是北京时间 ${beijing(now())}，下注已经截止。`,
          describeMarket(detail),
          '请联网搜索核实最终结果，然后调用 submit_result：',
          `- 结果已经明确：result 原样填写获胜的选项（${detail.outcomes.map((o) => `「${o.label}」`).join('、')}）；`,
          '- 结果还没公布或暂时查不到：result 填 "unknown"，过几个小时会再让你查；',
          '- 题目有歧义、事件取消或已经无法判定：result 填 "cancel"，所有下注全额退还。',
          'note 里用一两句话写明依据和来源。',
        ].join('\n\n'),
        maxSearches: RESEARCH_SEARCHES,
        tool: SUBMIT_RESULT,
      }),
    );
    if (parsed.success) answer = parsed.data;
  } catch (err) {
    log(`resolve: model call failed: ${(err as Error).message}`);
  }
  if (!answer) return 'unknown';
  const result = answer.result.trim().replace(/^「|」$/g, '');
  const note = answer.note.trim().slice(0, 1000) || undefined;
  if (result === 'cancel') {
    cancelMarket(db, market.id, market.creator_id, note, now());
    log(`resolve: #${market.id} cancelled — ${note}`);
    return 'cancelled';
  }
  const winner = detail.outcomes.find((o) => o.label === result);
  if (!winner) return 'unknown';
  resolveMarket(db, market.id, winner.id, market.creator_id, note, now());
  log(`resolve: #${market.id} → 「${winner.label}」 — ${note}`);
  return 'resolved';
}
