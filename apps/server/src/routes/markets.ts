import {
  betSchema,
  cancelMarketSchema,
  commentSchema,
  createMarketSchema,
  fromCents,
  resolveMarketSchema,
  convertSchema,
  mimicOrderSchema,
  orderSchema,
  shareAmountSchema,
  type BetResult,
  type MarketDetailResponse,
} from '@watercooler/shared';
import { Hono } from 'hono';
import { requireUser, type AppDeps, type AppEnv } from '../context';
import { badRequest, forbidden, parseBody, parseId } from '../lib/http';
import { getFeatureFlags } from '../services/admin';
import { cancelMarket, getBet, getUserStakes, listBets, listHolders, placeBet, resolveMarket } from '../services/bets';
import { addComment, deleteComment, listComments } from '../services/comments';
import {
  createMarket,
  getMarketDetail,
  getMarketRow,
  getPriceHistory,
  listMarkets,
  type HistoryRange,
  type MarketFilter,
  type MarketSort,
  type MarketZone,
} from '../services/markets';
import { getUserById } from '../services/users';
import { createPolymarketClient, type PolymarketClient } from '../mimic/client';
import { mirrorActivity, mirrorState, placeMirrorOrder } from '../services/mimic';
import {
  cancelOrder,
  convertShares,
  exchangeActivity,
  exchangeHolders,
  exchangeState,
  placeOrder,
  splitMerge,
} from '../services/exchange';

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function marketRoutes({ db, config, now, polymarket: client }: AppDeps) {
  const app = new Hono<AppEnv>();
  let real: PolymarketClient | undefined;
  const polymarket = () => client ?? (real ??= createPolymarketClient(config));

  const isMirror = (id: number) => getMarketRow(db, id).mimic_id !== null;
  app.get('/markets/:id/exchange', async (c) => {
    const id = parseId(c.req.param('id'));
    // Mirrors show Polymarket's live book of the option in view (?outcome=).
    if (isMirror(id))
      return c.json(
        await mirrorState(db, polymarket(), id, c.get('user')?.id, Number(c.req.query('outcome')) || undefined),
      );
    return c.json(exchangeState(db, id, now(), c.get('user')?.id));
  });
  app.get('/markets/:id/exchange/holders', (c) => c.json(exchangeHolders(db, parseId(c.req.param('id')))));
  app.get('/markets/:id/exchange/activity', (c) => {
    const id = parseId(c.req.param('id'));
    const before = Number(c.req.query('before')) || undefined;
    return c.json(
      isMirror(id) ? mirrorActivity(db, id, { before, limit: 100 }) : exchangeActivity(db, id, { before, limit: 50 }),
    );
  });
  app.post('/markets/:id/mimic/order', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, mimicOrderSchema);
    return c.json(await placeMirrorOrder(db, polymarket(), user.id, parseId(c.req.param('id')), input, now), 201);
  });
  app.post('/markets/:id/orders', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, orderSchema);
    return c.json(placeOrder(db, user.id, parseId(c.req.param('id')), input, now()), 201);
  });
  app.post('/markets/:id/orders/:orderId/cancel', (c) => {
    const user = requireUser(c);
    cancelOrder(db, user.id, parseId(c.req.param('id')), parseId(c.req.param('orderId')), now());
    return c.json({ ok: true });
  });
  for (const action of ['split', 'merge'] as const) {
    app.post(`/markets/:id/${action}`, async (c) => {
      const user = requireUser(c);
      const input = await parseBody(c, shareAmountSchema);
      splitMerge(db, user.id, parseId(c.req.param('id')), input.quantity, action, now(), input.outcomeId);
      return c.json({ ok: true });
    });
  }
  app.post('/markets/:id/convert', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, convertSchema);
    convertShares(db, user.id, parseId(c.req.param('id')), input.outcomeIds, input.quantity, now());
    return c.json({ ok: true });
  });

  app.get('/markets', (c) => {
    const q = c.req.query();
    if (q.mode && q.mode !== 'pool' && q.mode !== 'polymarket') throw badRequest('交易模式无效');
    return c.json(
      listMarkets(db, now(), {
        mode: q.mode as 'pool' | 'polymarket' | undefined,
        filter: pick<MarketFilter>(q.filter, ['active', 'closed', 'resolved', 'all'], 'active'),
        zone: pick<MarketZone>(q.zone, ['human', 'ai', 'mimic', 'werewolf', 'any'], 'human'),
        sort: pick<MarketSort>(q.sort, ['trending', 'pot', 'new', 'closing'], 'trending'),
        category: q.category || undefined,
        search: q.q?.trim() || undefined,
        creatorId: q.creator ? Number(q.creator) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });

  app.post('/markets', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, createMarketSchema);
    if (input.mode === 'polymarket' && !getFeatureFlags(db).polymarket) {
      throw forbidden('管理员已关闭 Polymarket 模式，只能创建奖池市场');
    }
    const id = createMarket(db, user.id, input, now());
    return c.json({ id }, 201);
  });

  app.get('/markets/:id', (c) => {
    const id = parseId(c.req.param('id'));
    const user = c.get('user');
    return c.json<MarketDetailResponse>({
      market: getMarketDetail(db, id, now()),
      stakes: user ? getUserStakes(db, user.id, id) : [],
    });
  });

  app.get('/markets/:id/history', (c) => {
    const id = parseId(c.req.param('id'));
    const range = pick<HistoryRange>(c.req.query('range'), ['1d', '1w', '1m', 'all'], 'all');
    return c.json(getPriceHistory(db, id, range, now()));
  });

  app.get('/markets/:id/bets', (c) => {
    const id = parseId(c.req.param('id'));
    const before = c.req.query('before');
    return c.json(listBets(db, { marketId: id, before: before ? Number(before) : undefined, limit: 50 }));
  });

  app.get('/markets/:id/holders', (c) => {
    const id = parseId(c.req.param('id'));
    getMarketRow(db, id);
    return c.json(listHolders(db, id));
  });

  app.post('/markets/:id/bets', async (c) => {
    const user = requireUser(c);
    const id = parseId(c.req.param('id'));
    const input = await parseBody(c, betSchema);
    const t = now();
    const betId = placeBet(db, user.id, id, input, t);
    return c.json<BetResult>({
      bet: getBet(db, betId),
      balance: fromCents(getUserById(db, user.id)!.balance),
      market: getMarketDetail(db, id, t),
      stakes: getUserStakes(db, user.id, id),
    });
  });

  app.post('/markets/:id/resolve', async (c) => {
    const user = requireUser(c);
    const id = parseId(c.req.param('id'));
    const input = await parseBody(c, resolveMarketSchema);
    const t = now();
    resolveMarket(db, id, input.outcomeId, user.id, input.note, t);
    return c.json(getMarketDetail(db, id, t));
  });

  app.post('/markets/:id/cancel', async (c) => {
    const user = requireUser(c);
    const id = parseId(c.req.param('id'));
    const input = await parseBody(c, cancelMarketSchema);
    const t = now();
    cancelMarket(db, id, user.id, input.note, t);
    return c.json(getMarketDetail(db, id, t));
  });

  app.get('/markets/:id/comments', (c) => {
    const id = parseId(c.req.param('id'));
    return c.json(listComments(db, id));
  });

  app.post('/markets/:id/comments', async (c) => {
    const user = requireUser(c);
    const id = parseId(c.req.param('id'));
    getMarketRow(db, id);
    const input = await parseBody(c, commentSchema);
    return c.json(addComment(db, id, user.id, input.body, now()), 201);
  });

  app.delete('/comments/:id', (c) => {
    const user = requireUser(c);
    deleteComment(db, parseId(c.req.param('id')), user);
    return c.json({ ok: true });
  });

  return app;
}
