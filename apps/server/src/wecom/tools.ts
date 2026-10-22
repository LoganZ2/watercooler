import type Anthropic from '@anthropic-ai/sdk';
import {
  CATEGORIES,
  createMarketSchema,
  CURRENCY_NAME,
  fromCents,
  MAX_BET,
  MAX_OUTCOMES,
  MIN_BET,
  mimicOrderSchema,
  orderSchema,
  payoutMultiplier,
  previewBet,
  toCents,
  type MarketSummary,
  type MimicOrderInput,
  type OrderInput,
} from '@watercooler/shared';
import type { Config } from '../config';
import type { DB } from '../db';
import { HttpError } from '../lib/http';
import { DAY, MINUTE } from '../lib/time';
import { getUserStakes } from '../services/bets';
import {
  available,
  describeShare,
  exchangePortfolio,
  exchangePortfolioOrders,
  exchangeState,
  quoteOrder,
  userPositions,
  winningHolders,
} from '../services/exchange';
import { mirrorShare } from '../services/mimic';
import {
  derivedStatus,
  getMarketDetail,
  getMarketRow,
  getOutcomeRows,
  isBettable,
  listMarkets,
  type MarketFilter,
  type MarketSort,
  type MarketRow,
  type OutcomeRow,
} from '../services/markets';
import { leaderboard, userBets, userStatsAndRank, type LeaderboardSort } from '../services/stats';
import { claimDailyBonus, getUserById, toMe } from '../services/users';
import { confirmationCard, createAction, type ActionPayload, type CardText } from './actions';
import type { Card } from './transport';

export interface ToolContext {
  db: DB;
  config: Config;
  now: number;
  siteUrl: string;
  userId: number;
  wecomUserId: string;
  /** The confirmation card this message will carry; one per message. */
  card: Card | null;
}

/** An error the model should see and explain (or fix and retry). */
class ToolError extends Error {}

export const formatTime = (t: number, timeZone: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(t);

const pct = (p: number) => `${Math.round(p * 1000) / 10}%`;
const money = (n: number) => Math.round(n * 100) / 100;
export const marketUrl = (siteUrl: string, id: number) => `${siteUrl}/market/${id}`;

const STATUS_LABEL = { open: '可下注', closed: '已截止待公布', resolved: '已公布', cancelled: '已取消' } as const;

function compactMarket(ctx: ToolContext, m: MarketSummary) {
  return {
    id: m.id,
    mode: m.mode,
    ...(m.mode === 'polymarket' ? { kind: m.isBinary ? 'Yes / No' : '多选（每个选项各有 Yes / No 份额）' } : {}),
    question: m.question,
    status: STATUS_LABEL[m.status],
    zone: m.isAi ? 'AI 专区' : '大家的盘',
    category: m.category,
    closeAt: formatTime(m.closeAt, ctx.config.timezone),
    pot: m.pot,
    bettors: m.bettorCount,
    creator: m.creator.displayName,
    outcomes: m.outcomes.map((o) => ({
      label: o.label,
      probability: pct(o.probability),
      ...(m.mode === 'polymarket' ? { bestBid: o.bestBid ?? null, bestAsk: o.bestAsk ?? null } : { pool: o.pool }),
      ...(m.resolvedOutcomeId === o.id ? { winner: true } : {}),
    })),
  };
}

function findMarket(db: DB, id: unknown): MarketRow {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ToolError('marketId 无效');
  try {
    return getMarketRow(db, n);
  } catch {
    throw new ToolError(`没有 id 为 ${n} 的市场`);
  }
}

/** Match an option by its label (case and surrounding spaces ignored) or by its 1-based number. */
function findOutcome(outcomes: OutcomeRow[], wanted: unknown): OutcomeRow {
  const text = String(wanted ?? '').trim();
  const byLabel = outcomes.find((o) => o.label.trim().toLowerCase() === text.toLowerCase());
  if (byLabel) return byLabel;
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n <= outcomes.length) return outcomes[n - 1]!;
  throw new ToolError(`没有这个选项。可选：${outcomes.map((o) => `「${o.label}」`).join('、')}`);
}

/** Parse an ISO 8601 time that names its time zone. */
function isoTime(value: unknown, name: string): number {
  const text = String(value ?? '');
  if (!/(z|[+-]\d{2}:?\d{2})$/i.test(text)) throw new ToolError(`${name} 要带时区，例如 +08:00`);
  const t = Date.parse(text);
  if (!Number.isFinite(t)) throw new ToolError(`${name} 不是有效的时间`);
  return t;
}

function polymarket(ctx: ToolContext, id: unknown): MarketRow {
  const market = findMarket(ctx.db, id);
  if (market.mode !== 'polymarket') throw new ToolError('这是奖池市场，请用 place_bet 下注');
  return market;
}

/** A share's name as people see it: 「小王 · No」 in multi-outcome markets. */
const shareName = (ctx: ToolContext, marketId: number, s: { outcomeId: number; token: 'yes' | 'no' }) =>
  describeShare(ctx.db, marketId, s.outcomeId, s.token).label;

const SIDE = { buy: '买入', sell: '卖出' } as const;

/** A mirror share's best bid/ask on Polymarket as of the last sync (a No share's are the Yes ones flipped). */
function mirrorQuotes(ctx: ToolContext, market: MarketRow, outcomeId: number, token: 'yes' | 'no') {
  const s = mirrorShare(ctx.db, market, outcomeId, token);
  const c = (v: number | null) => (v === null ? null : Math.round(v * 10) / 1000);
  const bid = c(s.option.mimic_bid);
  const ask = c(s.option.mimic_ask);
  const flipped = s.token === 1;
  return {
    share: s,
    label: s.label,
    bid: flipped ? (ask === null ? null : money(1 - ask)) : bid,
    ask: flipped ? (bid === null ? null : money(1 - bid)) : ask,
    open: s.option.mimic_open === 1 && s.option.mimic_final === null,
  };
}

/**
 * A mirror market order on a card. The preview uses the last synced quote; the confirmed order
 * trades Polymarket's live book, never past a worst price two cents beyond that quote.
 */
function proposeMirrorOrder(ctx: ToolContext, market: MarketRow, input: Input): string {
  if (input.orderType === 'limit') throw new ToolError('镜像盘只能按 Polymarket 的实时价下市价单，不能挂限价单');
  const outcome = findOutcome(getOutcomeRows(ctx.db, market.id), input.outcome);
  const side = oneOf(input.side, ['buy', 'sell'] as const, 'buy');
  const q = mirrorQuotes(ctx, market, outcome.id, input.share === 'no' ? 'no' : 'yes');
  if (!q.open) throw new ToolError('这个选项在 Polymarket 上已经停止交易了');
  const ref = side === 'buy' ? q.ask : q.bid;
  if (ref === null || ref <= 0 || ref >= 1) throw new ToolError('Polymarket 上这个份额现在没有可成交的报价');
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const worst =
    num(input.price) ??
    Math.min(
      0.99,
      Math.max(0.01, side === 'buy' ? Math.ceil((ref + 0.02) * 100) / 100 : Math.floor((ref - 0.02) * 100) / 100),
    );
  const order: MimicOrderInput = {
    outcomeId: q.share.outcome,
    token: q.share.token === 1 ? 'no' : 'yes',
    side,
    type: input.fok ? 'FOK' : 'FAK',
    price: worst,
    ...(side === 'buy' && num(input.amount) !== undefined
      ? { amount: num(input.amount) }
      : { quantity: num(input.shares) }),
  };
  const parsed = mimicOrderSchema.safeParse(order);
  if (!parsed.success) throw new ToolError(parsed.error.issues[0]?.message ?? '订单参数不对');
  const balance = fromCents(getUserById(ctx.db, ctx.userId)!.balance);
  if (side === 'buy' && (order.amount ?? ref * order.quantity!) > balance)
    throw new ToolError(`余额不足：用户现在只有 ${balance} ${CURRENCY_NAME}`);
  if (side === 'sell') {
    const held = available(ctx.db, ctx.userId, q.share);
    if (held < order.quantity!) throw new ToolError(`用户只有 ${held} 份「${q.label}」可卖`);
  }
  return propose(
    ctx,
    { kind: 'mimic_order', marketId: market.id, input: order },
    {
      title: `确认${SIDE[side]}「${q.label}」`,
      desc: market.question,
      rows: [
        ['份额', q.label],
        ['方向', `${SIDE[side]} · Polymarket 实时价`],
        ['参考价', ref.toFixed(3)],
        order.amount !== undefined
          ? ['预计', `约 ${Math.floor(order.amount / ref)} 份，花 ${order.amount} ${CURRENCY_NAME}`]
          : ['预计', `${order.quantity} 份，约 ${money(ref * order.quantity!)} ${CURRENCY_NAME}`],
        ['最差价', worst.toFixed(2)],
      ],
      note: '确认时按 Polymarket 的实时盘口成交，对手是本站，不影响 Polymarket；比最差价更差的部分不成交。结果以 Polymarket 为准。',
      url: marketUrl(ctx.siteUrl, market.id),
    },
  );
}

function propose(ctx: ToolContext, payload: ActionPayload, text: CardText): string {
  if (ctx.card) throw new ToolError('这条消息已经有一个待确认的操作了，一次只能确认一个，请让用户先处理那一个');
  const action = createAction(ctx.db, ctx.userId, ctx.wecomUserId, payload, ctx.now);
  ctx.card = confirmationCard(action, text);
  return '已经给用户发了确认卡片，用户点「确认」后才会执行（10 分钟内有效）。告诉用户点卡片确认即可，不要说已经完成。';
}

type Input = Record<string, unknown>;

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

interface ToolDef {
  tool: Anthropic.Beta.BetaTool;
  run: (ctx: ToolContext, input: Input) => unknown;
}

const tools: ToolDef[] = [
  {
    tool: {
      name: 'list_markets',
      description: '列出市场（预测题）。默认列出大家建的、正在下注的盘。',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'closed', 'resolved'],
            description: 'active 可下注；closed 已截止待公布；resolved 已公布或已取消',
          },
          zone: {
            type: 'string',
            enum: ['human', 'ai', 'mimic', 'all'],
            description: 'human 大家建的盘；ai AI 专区；mimic Polymarket 热门镜像盘（按 Polymarket 排名）',
          },
          sort: { type: 'string', enum: ['trending', 'pot', 'new', 'closing'] },
          search: { type: 'string', description: '按问题关键词搜索' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
    },
    run: (ctx, input) => {
      const zone =
        input.zone === 'ai' ? 'ai' : input.zone === 'mimic' ? 'mimic' : input.zone === 'all' ? 'any' : 'human';
      const markets = listMarkets(ctx.db, ctx.now, {
        filter: oneOf<MarketFilter>(input.status, ['active', 'closed', 'resolved'], 'active'),
        zone,
        sort: oneOf<MarketSort>(input.sort, ['trending', 'pot', 'new', 'closing'], 'trending'),
        search: typeof input.search === 'string' && input.search.trim() ? input.search.trim() : undefined,
        limit: Math.min(Math.max(Number(input.limit) || 10, 1), 20),
      });
      return markets.map((m) => compactMarket(ctx, m));
    },
  },
  {
    tool: {
      name: 'get_market',
      description: '查看一个市场的详情：规则说明、各选项奖池和赔率、用户自己的押注、链接。',
      input_schema: {
        type: 'object',
        properties: { marketId: { type: 'integer' } },
        required: ['marketId'],
      },
    },
    run: (ctx, input) => {
      const row = findMarket(ctx.db, input.marketId);
      const m = getMarketDetail(ctx.db, row.id, ctx.now);
      if (row.mimic_id) {
        const outcomes = getOutcomeRows(ctx.db, row.id);
        const shares = row.neg_risk
          ? outcomes.flatMap((o) => [mirrorQuotes(ctx, row, o.id, 'yes'), mirrorQuotes(ctx, row, o.id, 'no')])
          : outcomes.map((o) => mirrorQuotes(ctx, row, o.id, 'yes'));
        return {
          ...compactMarket(ctx, m),
          source: 'polymarket.com 镜像盘',
          polymarketRank: m.mimic?.rank ?? null,
          polymarketVolume24hUsd: Math.round(m.mimic?.volume24h ?? 0),
          description: m.description.slice(0, 1500),
          quotes: shares.map((q) => ({ share: q.label, bestBid: q.bid, bestAsk: q.ask, trading: q.open })),
          myPositions: userPositions(ctx.db, m.id, ctx.userId)
            .filter((p) => p.quantity > 0)
            .map((p) => ({
              share: mirrorShare(ctx.db, row, p.outcomeId, p.token).label,
              shares: p.quantity,
              avgPrice: p.avgPrice,
            })),
          trading:
            '镜像 polymarket.com 的盘：按 Polymarket 的实时盘口买卖，对手是本站，交易不会影响 Polymarket；只能下市价单（place_order，orderType=market）。报价是最近一次同步的，确认时按实时盘口成交。结果以 Polymarket 为准，自动结算。',
          url: marketUrl(ctx.siteUrl, m.id),
        };
      }
      if (m.mode === 'polymarket') {
        const state = exchangeState(ctx.db, m.id, ctx.now, ctx.userId);
        const name = (s: { outcomeId: number; token: 'yes' | 'no' }) => shareName(ctx, m.id, s);
        return {
          ...compactMarket(ctx, m),
          description: m.description.slice(0, 1500),
          settleAt: formatTime(m.settleAt, ctx.config.timezone),
          createdByMe: m.creator.id === ctx.userId,
          shares: state.books.map((b) => ({
            share: name(b),
            bestBid: b.bids[0]?.price ?? null,
            bestAsk: b.asks[0]?.price ?? null,
            lastPrice: b.lastPrice,
          })),
          myPositions: state.positions
            .filter((p) => p.quantity > 0)
            .map((p) => ({ share: name(p), shares: p.quantity, reservedForSale: p.reserved, avgPrice: p.avgPrice })),
          myOpenOrders: state.orders
            .filter((o) => o.status === 'open')
            .map((o) => ({
              orderId: o.id,
              share: name(o),
              side: SIDE[o.side],
              price: o.price,
              remaining: o.remaining,
              ...(o.expiresAt ? { expiresAt: formatTime(o.expiresAt, ctx.config.timezone) } : {}),
            })),
          trading:
            '获胜份额每份兑回 1，落败兑回 0；bestAsk 是现在买入要付的价，bestBid 是现在卖出能拿的价。用 place_order 下单，cancel_order 撤单。市场不可取消。',
          url: marketUrl(ctx.siteUrl, m.id),
        };
      }
      const pools = m.outcomes.map((o) => o.pool);
      const stakes = getUserStakes(ctx.db, ctx.userId, m.id);
      return {
        ...compactMarket(ctx, m),
        description: m.description.slice(0, 1500),
        outcomes: m.outcomes.map((o, i) => {
          const multiplier = payoutMultiplier(pools, i);
          return {
            label: o.label,
            probability: pct(o.probability),
            pool: o.pool,
            payoutPerUnit: multiplier === null ? '还没人押，押中可拿走整个奖池' : money(multiplier),
            myStake: stakes.find((s) => s.outcomeId === o.id)?.amount ?? 0,
            ...(m.resolvedOutcomeId === o.id ? { winner: true } : {}),
          };
        }),
        createdByMe: m.creator.id === ctx.userId,
        settleAt: formatTime(m.settleAt, ctx.config.timezone),
        autoCancelAt: formatTime(m.resolveBy!, ctx.config.timezone),
        resolutionNote: m.resolutionNote,
        url: marketUrl(ctx.siteUrl, m.id),
      };
    },
  },
  {
    tool: {
      name: 'my_account',
      description:
        '用户自己的账户：余额、能否签到、已结算盈亏和排名、进行中的押注、Polymarket 持仓（均价、按现价估算的价值和盈亏）和挂单、自己建的待公布的盘。净值和排名不计入未结算市场的盈亏。',
      input_schema: { type: 'object', properties: {} },
    },
    run: (ctx) => {
      const user = getUserById(ctx.db, ctx.userId)!;
      const me = toMe(user, ctx.config, ctx.now);
      const { stats, rank } = userStatsAndRank(ctx.db, ctx.userId);
      const bets = userBets(ctx.db, ctx.userId, ctx.now);
      const toResolve = listMarkets(ctx.db, ctx.now, {
        filter: 'closed',
        zone: 'any',
        creatorId: ctx.userId,
        sort: 'closing',
        limit: 10,
      });
      return {
        name: me.displayName,
        username: me.username,
        balance: me.balance,
        canClaimDailyBonus: me.canClaimBonus,
        netWorth: stats.netWorth,
        profit: stats.profit,
        rank,
        activeBets: bets
          .filter((b) => b.state === 'active')
          .slice(0, 15)
          .map((b) => ({
            marketId: b.market.id,
            question: b.market.question,
            outcome: b.outcomeLabel,
            stake: b.stake,
            payoutIfWins: money(b.payout),
          })),
        recentlySettled: bets
          .filter((b) => b.state !== 'active')
          .slice(0, 5)
          .map((b) => ({ question: b.market.question, outcome: b.outcomeLabel, result: b.state, pnl: b.pnl })),
        polymarketPositions: exchangePortfolio(ctx.db, ctx.userId, ctx.now)
          .filter((p) => p.status === 'open' || p.status === 'closed')
          .slice(0, 15)
          .map((p) => ({
            marketId: p.marketId,
            question: p.question,
            share: p.outcomeLabel,
            shares: p.quantity,
            reservedForSale: p.reserved,
            avgPrice: p.avgPrice,
            estimatedValue: p.value,
            estimatedPnl: p.pnl,
          })),
        polymarketOpenOrders: exchangePortfolioOrders(ctx.db, ctx.userId)
          .slice(0, 15)
          .map((o) => ({
            orderId: o.id,
            question: o.question,
            share: o.outcomeLabel,
            side: SIDE[o.side],
            price: o.price,
            remaining: o.remaining,
            ...(o.expiresAt ? { expiresAt: formatTime(o.expiresAt, ctx.config.timezone) } : {}),
          })),
        myMarketsToResolve: toResolve.map((m) => ({ id: m.id, question: m.question })),
      };
    },
  },
  {
    tool: {
      name: 'leaderboard',
      description:
        '排行榜（只有人，不含 AI 机器人）。盈利仅统计已结算市场的净收支，净值为注册及签到奖励加已结算盈利；未结算交易不影响这两项排名。',
      input_schema: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['profit', 'netWorth', 'bets'], description: '已结算盈利、入账净值或下注次数' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
    },
    run: (ctx, input) => {
      const sort = oneOf<LeaderboardSort>(input.sort, ['profit', 'netWorth', 'bets'], 'profit');
      return leaderboard(ctx.db, sort)
        .slice(0, Math.min(Math.max(Number(input.limit) || 10, 1), 20))
        .map((e) => ({
          rank: e.rank,
          name: e.user.displayName,
          isMe: e.user.id === ctx.userId,
          profit: e.stats.profit,
          netWorth: e.stats.netWorth,
          bets: e.stats.betCount,
        }));
    },
  },
  {
    tool: {
      name: 'claim_daily_bonus',
      description: `领取每日签到奖励（${CURRENCY_NAME}），每天一次，直接到账。`,
      input_schema: { type: 'object', properties: {} },
    },
    run: (ctx) => {
      const balance = claimDailyBonus(ctx.db, ctx.config, ctx.userId, ctx.now);
      return { claimed: ctx.config.dailyBonus, balance: fromCents(balance) };
    },
  },
  {
    tool: {
      name: 'place_bet',
      description: '给用户下注。不会马上执行：会发一张确认卡片，用户点确认才扣钱。',
      input_schema: {
        type: 'object',
        properties: {
          marketId: { type: 'integer' },
          outcome: { type: 'string', description: '选项名称，和市场里的选项一致' },
          amount: { type: 'number', minimum: MIN_BET, maximum: MAX_BET, description: `金额（${CURRENCY_NAME}）` },
        },
        required: ['marketId', 'outcome', 'amount'],
      },
    },
    run: (ctx, input) => {
      const market = findMarket(ctx.db, input.marketId);
      if (market.mode !== 'pool') throw new ToolError('这是 Polymarket 市场，请用 place_order 买卖份额');
      if (!isBettable(market, ctx.now)) throw new ToolError('这个市场已经停止下注了');
      const outcomes = getOutcomeRows(ctx.db, market.id);
      const outcome = findOutcome(outcomes, input.outcome);
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount < MIN_BET || amount > MAX_BET) {
        throw new ToolError(`金额要在 ${MIN_BET} 到 ${MAX_BET} 之间`);
      }
      const cents = toCents(amount);
      const user = getUserById(ctx.db, ctx.userId)!;
      if (cents > user.balance)
        throw new ToolError(`余额不足：用户现在只有 ${fromCents(user.balance)} ${CURRENCY_NAME}`);
      const pools = outcomes.map((o) => fromCents(o.pool));
      const idx = outcomes.indexOf(outcome);
      const stake = getUserStakes(ctx.db, ctx.userId, market.id).find((s) => s.outcomeId === outcome.id)?.amount ?? 0;
      const preview = previewBet(pools, idx, fromCents(cents), stake);
      return propose(
        ctx,
        { kind: 'bet', marketId: market.id, outcomeId: outcome.id, amount: fromCents(cents) },
        {
          title: `确认下注 ${fromCents(cents)} ${CURRENCY_NAME}`,
          desc: market.question,
          rows: [
            ['选项', outcome.label],
            ['金额', `${fromCents(cents)} ${CURRENCY_NAME}`],
            ['押中可得', `约 ${money(preview.payout)}（按当前奖池）`],
            ['截止', formatTime(market.close_at, ctx.config.timezone)],
          ],
          note:
            stake > 0 ? `你在这个选项上已经押了 ${stake}，确认后合计 ${money(stake + fromCents(cents))}` : undefined,
          url: marketUrl(ctx.siteUrl, market.id),
        },
      );
    },
  },
  {
    tool: {
      name: 'get_order_book',
      description:
        '查看 Polymarket 市场某个份额的盘口（已合并互补挂单：买 No @0.40 等于卖 Yes @0.60）：买单、卖单各前 5 档、价差和最新成交价。',
      input_schema: {
        type: 'object',
        properties: {
          marketId: { type: 'integer' },
          outcome: { type: 'string', description: '选项名称；是非题写 Yes 或 No' },
          share: { type: 'string', enum: ['yes', 'no'], description: '多选市场里看这个选项的 Yes 还是 No，默认 yes' },
        },
        required: ['marketId', 'outcome'],
      },
    },
    run: (ctx, input) => {
      const market = polymarket(ctx, input.marketId);
      const outcome = findOutcome(getOutcomeRows(ctx.db, market.id), input.outcome);
      if (market.mimic_id) {
        const q = mirrorQuotes(ctx, market, outcome.id, input.share === 'no' ? 'no' : 'yes');
        return {
          share: q.label,
          bestBid: q.bid,
          bestAsk: q.ask,
          trading: q.open,
          note: '镜像盘只给出 Polymarket 最近一次同步的买一卖一；完整的实时盘口请到网站看。',
        };
      }
      const share = describeShare(ctx.db, market.id, outcome.id, input.share === 'no' ? 'no' : 'yes');
      const book = exchangeState(ctx.db, market.id, ctx.now).books.find(
        (b) => b.outcomeId === share.outcomeId && b.token === share.token,
      )!;
      const bid = book.bids[0]?.price;
      const ask = book.asks[0]?.price;
      return {
        share: share.label,
        bids: book.bids.slice(0, 5),
        asks: book.asks.slice(0, 5),
        spread: bid !== undefined && ask !== undefined ? money(ask - bid) : null,
        lastPrice: book.lastPrice,
        tradingOpen: isBettable(market, ctx.now),
      };
    },
  },
  {
    tool: {
      name: 'place_order',
      description: `在 Polymarket 市场替用户买卖份额（奖池市场用 place_bet）。每份获胜兑回 1 ${CURRENCY_NAME}，落败 0。
市价单 orderType=market：马上按盘口逐档成交，买入填 amount（花多少${CURRENCY_NAME}，只买整份），卖出填 shares；成交不了的部分直接取消，fok=true 时不能全部成交就整单取消。
限价单 orderType=limit：填 price（0.01–0.99）和 shares，没成交的部分挂在订单簿上；可选 expiresAt 到期自动撤单，postOnly=true 只挂单不吃单。
不会马上执行：会发确认卡片，用户点确认才下单。`,
      input_schema: {
        type: 'object',
        properties: {
          marketId: { type: 'integer' },
          outcome: { type: 'string', description: '选项名称；是非题写 Yes 或 No' },
          share: {
            type: 'string',
            enum: ['yes', 'no'],
            description: '多选市场里买卖这个选项的 Yes（会发生）还是 No（不会发生），默认 yes；是非题不用填',
          },
          side: { type: 'string', enum: ['buy', 'sell'] },
          orderType: { type: 'string', enum: ['market', 'limit'] },
          amount: { type: 'number', description: `市价买入时花多少${CURRENCY_NAME}` },
          shares: { type: 'integer', minimum: 1, description: '份数：卖出或限价单' },
          price: { type: 'number', description: '限价单的价格；市价单可选，作为最差成交价' },
          fok: { type: 'boolean', description: '市价单：不能全部成交就整单取消' },
          expiresAt: { type: 'string', description: '限价单到期时间，ISO 8601 带时区，可选' },
          postOnly: { type: 'boolean', description: '限价单：会立即成交就拒绝，只挂单' },
        },
        required: ['marketId', 'outcome', 'side', 'orderType'],
      },
    },
    run: (ctx, input) => {
      const market = polymarket(ctx, input.marketId);
      if (!isBettable(market, ctx.now)) throw new ToolError('这个市场已经停止交易了');
      if (market.mimic_id) return proposeMirrorOrder(ctx, market, input);
      const outcome = findOutcome(getOutcomeRows(ctx.db, market.id), input.outcome);
      const side = oneOf(input.side, ['buy', 'sell'] as const, 'buy');
      const token = input.share === 'no' ? ('no' as const) : ('yes' as const);
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
      const isMarket = input.orderType !== 'limit';
      const order: OrderInput = isMarket
        ? {
            outcomeId: outcome.id,
            token,
            side,
            type: input.fok ? 'FOK' : 'FAK',
            ...(side === 'buy' && num(input.amount) !== undefined
              ? { amount: num(input.amount) }
              : { quantity: num(input.shares) }),
            ...(num(input.price) !== undefined ? { price: num(input.price) } : {}),
          }
        : {
            outcomeId: outcome.id,
            token,
            side,
            type: input.expiresAt ? 'GTD' : 'GTC',
            price: num(input.price),
            quantity: num(input.shares),
            ...(input.expiresAt ? { expiresAt: isoTime(input.expiresAt, 'expiresAt') } : {}),
            postOnly: input.postOnly === true,
          };
      const parsed = orderSchema.safeParse(order);
      if (!parsed.success) throw new ToolError(parsed.error.issues[0]?.message ?? '订单参数不对');
      const { label, plan } = quoteOrder(ctx.db, ctx.userId, market.id, order, ctx.now);
      const balance = fromCents(getUserById(ctx.db, ctx.userId)!.balance);
      const state = exchangeState(ctx.db, market.id, ctx.now, ctx.userId);
      const share = describeShare(ctx.db, market.id, outcome.id, token);
      const held = state.positions.find((p) => p.outcomeId === share.outcomeId && p.token === share.token);
      const available = (held?.quantity ?? 0) - (held?.reserved ?? 0);
      if (side === 'sell' && (order.quantity ?? 0) > available)
        throw new ToolError(`用户只有 ${available} 份「${label}」可卖`);

      const rows: [string, string][] = [
        ['份额', label],
        ['方向', `${SIDE[side]} · ${isMarket ? (order.type === 'FOK' ? '市价 FOK' : '市价') : '限价'}`],
      ];
      let note: string;
      if (isMarket) {
        if (plan.quantity === 0) throw new ToolError('盘口上现在没有可成交的对手单，可以改挂限价单');
        if (order.type === 'FOK' && !plan.complete)
          throw new ToolError(`盘口只够成交 ${plan.quantity} 份，FOK 会整单取消`);
        if (side === 'buy' && order.amount !== undefined && order.amount > balance)
          throw new ToolError(`余额不足：用户现在只有 ${balance} ${CURRENCY_NAME}`);
        // Never fill worse than the preview: a moved book fills less instead of costing more.
        order.price ??= plan.worstPrice!;
        rows.push(
          ['预计成交', `${plan.quantity} 份，均价 ${plan.avgPrice!.toFixed(2)}`],
          [side === 'buy' ? '花费' : '收到', `${money(plan.total)} ${CURRENCY_NAME}`],
        );
        if (side === 'buy') rows.push(['赢了可得', `${plan.quantity} ${CURRENCY_NAME}`]);
        note = `最差成交价 ${order.price.toFixed(2)}；确认时盘口变了，少成交的部分自动取消。`;
      } else {
        const total = money(order.price! * order.quantity!);
        if (side === 'buy' && total > balance)
          throw new ToolError(`余额不足：用户现在只有 ${balance} ${CURRENCY_NAME}`);
        rows.push(
          ['价格 × 份数', `${order.price!.toFixed(2)} × ${order.quantity}`],
          [side === 'buy' ? '冻结' : '至少收到', `${total} ${CURRENCY_NAME}`],
        );
        if (plan.quantity > 0) rows.push(['立即成交', `约 ${plan.quantity} 份`]);
        note = order.expiresAt
          ? `没成交的部分挂单到 ${formatTime(order.expiresAt, ctx.config.timezone)}，到期自动撤销。`
          : '没成交的部分会挂在订单簿上，可以随时撤单。';
      }
      return propose(
        ctx,
        { kind: 'order', marketId: market.id, input: order },
        {
          title: `确认${SIDE[side]}「${label}」`,
          desc: market.question,
          rows,
          note,
          url: marketUrl(ctx.siteUrl, market.id),
        },
      );
    },
  },
  {
    tool: {
      name: 'cancel_order',
      description:
        '撤销用户自己在 Polymarket 的未成交挂单（orderId 来自 my_account 或 get_market），已成交部分不受影响。会发确认卡片。',
      input_schema: {
        type: 'object',
        properties: { orderId: { type: 'integer' } },
        required: ['orderId'],
      },
    },
    run: (ctx, input) => {
      const order = ctx.db
        .prepare('SELECT * FROM exchange_orders WHERE id = ? AND user_id = ?')
        .get(Number(input.orderId), ctx.userId) as
        | {
            id: number;
            market_id: number;
            outcome_id: number;
            token: 0 | 1;
            side: 'buy' | 'sell';
            price: number;
            remaining: number;
            status: string;
          }
        | undefined;
      if (!order) throw new ToolError('没有这个订单，或者不是用户自己的订单');
      if (order.status !== 'open') throw new ToolError('这个订单已经成交或撤销了');
      const market = findMarket(ctx.db, order.market_id);
      return propose(
        ctx,
        { kind: 'cancel_order', marketId: market.id, orderId: order.id },
        {
          title: '确认撤单',
          desc: market.question,
          rows: [
            ['份额', shareName(ctx, market.id, { outcomeId: order.outcome_id, token: order.token ? 'no' : 'yes' })],
            ['方向', SIDE[order.side]],
            ['价格', fromCents(order.price).toFixed(2)],
            ['剩余', `${order.remaining} 份`],
          ],
          note: '撤销没成交的部分，冻结的资金或份额会退回。',
          url: marketUrl(ctx.siteUrl, market.id),
        },
      );
    },
  },
  {
    tool: {
      name: 'create_market',
      description:
        '以用户的名义开一个新盘（预测题）。默认奖池模式；也可以开 Polymarket 份额市场。不会马上执行：会发确认卡片，用户确认后才创建。',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题，5-200 字，要有明确的判定标准' },
          description: { type: 'string', description: '规则说明：怎么判定、以什么为准' },
          category: { type: 'string', enum: [...CATEGORIES] },
          closeAt: {
            type: 'string',
            description: '截止下注时间，ISO 8601 并带时区，如 2026-10-20T18:00:00+08:00',
          },
          outcomes: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: MAX_OUTCOMES,
            description: '选项；奖池是非题用 ["是", "否"]；Polymarket 是非题必须是 ["Yes", "No"]，多选至少 3 个选项',
          },
          mode: {
            type: 'string',
            enum: ['pool', 'polymarket'],
            description: 'pool 奖池模式（默认）；polymarket 份额订单簿，不可取消，到结算时间后公布',
          },
          settleAt: {
            type: 'string',
            description: '结算时间（可选，默认等于 closeAt），ISO 8601 并带时区；不能早于 closeAt',
          },
        },
        required: ['question', 'category', 'closeAt', 'outcomes'],
      },
    },
    run: (ctx, input) => {
      const closeAt = isoTime(input.closeAt, 'closeAt');
      const settleAt = input.settleAt ? isoTime(input.settleAt, 'settleAt') : undefined;
      const mode = oneOf(input.mode, ['pool', 'polymarket'] as const, 'pool');
      if (closeAt <= ctx.now + 5 * MINUTE) throw new ToolError('截止时间至少要在 5 分钟之后');
      if (closeAt > ctx.now + 5 * 365 * DAY) throw new ToolError('截止时间不能超过 5 年');
      const parsed = createMarketSchema.safeParse({
        question: input.question,
        description: input.description ?? '',
        category: input.category,
        closeAt,
        settleAt,
        mode,
        outcomes: input.outcomes,
      });
      if (!parsed.success) throw new ToolError(parsed.error.issues[0]?.message ?? '参数不对');
      const m = parsed.data;
      if (!(CATEGORIES as readonly string[]).includes(m.category)) {
        throw new ToolError(`分类只能是：${CATEGORIES.join('、')}`);
      }
      return propose(
        ctx,
        { kind: 'create', input: m },
        {
          title: '确认开盘',
          desc: m.question,
          rows: [
            ['模式', m.mode === 'polymarket' ? 'Polymarket 份额' : '奖池'],
            ['选项', m.outcomes.join(' / ')],
            ['分类', m.category],
            ['截止', formatTime(m.closeAt, ctx.config.timezone)],
            ...(m.settleAt !== undefined && m.settleAt !== m.closeAt
              ? [['结算', formatTime(m.settleAt, ctx.config.timezone)] as [string, string]]
              : []),
          ],
          note: m.description || '截止后由你公布结果',
        },
      );
    },
  },
  {
    tool: {
      name: 'resolve_market',
      description:
        '公布用户自己创建的市场的结果并结算：奖池模式按押注比例分配；Polymarket 获胜份额每份兑回 1，落败份额兑回 0。Polymarket 要到结算时间后才能公布；奖池结果确定后随时可以公布，提前公布会立即停止下注。不会马上执行：会发确认卡片，用户确认后才结算，结算后不能撤销。',
      input_schema: {
        type: 'object',
        properties: {
          marketId: { type: 'integer' },
          outcome: { type: 'string', description: '胜出的选项名称' },
          note: { type: 'string', description: '结果说明或依据，可选' },
        },
        required: ['marketId', 'outcome'],
      },
    },
    run: (ctx, input) => {
      const market = findMarket(ctx.db, input.marketId);
      if (market.creator_id !== ctx.userId) throw new ToolError('只有市场创建者可以公布结果，这个盘不是用户建的');
      if (market.status !== 'open') throw new ToolError('这个市场已经结算或取消了');
      const outcomes = getOutcomeRows(ctx.db, market.id);
      const outcome = findOutcome(outcomes, input.outcome);
      const winners =
        market.mode === 'polymarket'
          ? winningHolders(ctx.db, market.id, outcome.id)
          : (
              ctx.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM bets WHERE outcome_id = ?').get(outcome.id) as {
                n: number;
              }
            ).n;
      // Polymarket waits for the settlement time; pool creators may announce early.
      if (market.mode === 'polymarket' && ctx.now < market.settle_at) {
        throw new ToolError(`要到结算时间 ${formatTime(market.settle_at, ctx.config.timezone)} 之后才能公布结果`);
      }
      const early = derivedStatus(market, ctx.now) === 'open';
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : undefined;
      return propose(
        ctx,
        { kind: 'resolve', marketId: market.id, outcomeId: outcome.id, note },
        {
          title: `确认结果：${outcome.label}`,
          desc: market.question,
          rows: [
            ['结果', outcome.label],
            [market.mode === 'polymarket' ? '抵押资金' : '奖池', `${fromCents(market.pot)} ${CURRENCY_NAME}`],
            market.mode === 'polymarket'
              ? ['获胜持有人', String(winners)]
              : ['押中人数', winners > 0 ? String(winners) : '没人押中，全部退还'],
            ...(market.mode === 'polymarket'
              ? [['兑付规则', `获胜每份兑回 1 ${CURRENCY_NAME}，落败每份兑回 0`] as [string, string]]
              : []),
          ],
          note: `${early ? '还没到截止时间，确认后提前结束下注并结算。' : ''}结算后不能撤销。${note ? `说明：${note}` : ''}`,
          url: marketUrl(ctx.siteUrl, market.id),
        },
      );
    },
  },
  {
    tool: {
      name: 'cancel_market',
      description:
        '取消用户自己创建的奖池市场，所有押注全额退还；Polymarket 市场不可取消。不会马上执行：会发确认卡片，用户确认后才取消。',
      input_schema: {
        type: 'object',
        properties: {
          marketId: { type: 'integer' },
          note: { type: 'string', description: '取消原因，可选' },
        },
        required: ['marketId'],
      },
    },
    run: (ctx, input) => {
      const market = findMarket(ctx.db, input.marketId);
      if (market.creator_id !== ctx.userId) throw new ToolError('只有市场创建者可以取消，这个盘不是用户建的');
      if (market.mode === 'polymarket')
        throw new ToolError('Polymarket 市场不可取消，只能等待公布结果结算；未成交订单请到网站撤销');
      if (market.status !== 'open') throw new ToolError('这个市场已经结算或取消了');
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : undefined;
      return propose(
        ctx,
        { kind: 'cancel', marketId: market.id, note },
        {
          title: '确认取消市场',
          desc: market.question,
          rows: [['奖池', `${fromCents(market.pot)} ${CURRENCY_NAME}，全部退还`]],
          note: note ? `原因：${note}` : '取消后不能恢复',
          url: marketUrl(ctx.siteUrl, market.id),
        },
      );
    },
  },
];

export const chatTools: Anthropic.Beta.BetaTool[] = tools.map((t) => t.tool);

/** Run a tool call; failures come back as an error result the model can explain. */
export function runTool(ctx: ToolContext, name: string, input: unknown): { content: string; isError: boolean } {
  const def = tools.find((t) => t.tool.name === name);
  if (!def) return { content: `没有 ${name} 这个工具`, isError: true };
  try {
    const result = def.run(ctx, (input ?? {}) as Input);
    return { content: typeof result === 'string' ? result : JSON.stringify(result), isError: false };
  } catch (err) {
    if (err instanceof ToolError || err instanceof HttpError) return { content: err.message, isError: true };
    throw err;
  }
}

export const RULES = `玩法一（奖池制）：每个选项一个奖池，押注进入所选选项的奖池；概率 = 该选项奖池占总奖池的比例。结果公布后，押中的人按押注比例分走整个奖池（包括押错的人的钱）；没人押中就全部退还。网站不抽成也不补贴。市场由创建者自己公布结果，只有奖池市场可主动取消。停止交易与结算时间分开设置：Polymarket 市场到结算时间后才能公布；奖池市场结果确定后随时可以公布，提前公布会立即停止下注；奖池模式在结算时间后 7 天未公布会自动取消并退款；Polymarket 市场不可取消，保留持仓和抵押资金等待结算，未成交订单仍可撤销。AI 专区的题由 AI 机器人出题和公布，人可以去押注。
Polymarket 镜像盘：从 polymarket.com 同步的最热门的盘，用${CURRENCY_NAME}按 Polymarket 的实时盘口买卖份额（只有市价单），对手是本站，交易不影响 Polymarket 的价格；Polymarket 出结果后按它的结果自动兑付，每份获胜兑回 1。
玩法二（Polymarket 份额）：每个是非题有 Yes、No 两种份额，多选题的每个选项各有一对 Yes / No；结果公布后获胜份额每份兑回 1，落败份额兑回 0。价格 0.01–0.99 就是大家认为的概率。份额在订单簿上买卖：市价单按盘口马上成交，限价单挂单等别人成交，可设到期时间；1 ${CURRENCY_NAME}可以拆成一对 Yes + No，也能合并换回。不收手续费。`;
