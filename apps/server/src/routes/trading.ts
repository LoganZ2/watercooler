import { convertSchema, orderSchema, shareAmountSchema, tradingOrderSchema } from '@watercooler/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppDeps, type AppEnv, type Ctx } from '../context';
import { badRequest, parseBody, parseId } from '../lib/http';
import {
  cancelOrder,
  convertShares,
  exchangePortfolio,
  exchangePortfolioOrders,
  exchangeState,
  placeOrder,
  splitMerge,
} from '../services/exchange';
import { getMarketRow, derivedStatus } from '../services/markets';
import { userStatsAndRank } from '../services/stats';
import { marketTrades, ownedOrder, tradingFills, tradingOrders } from '../services/trading';
import { getUserById, toMe } from '../services/users';

const pageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  marketId: z.coerce.number().int().positive().optional(),
});
const ordersQuery = pageQuery.extend({
  status: z.enum(['open', 'filled', 'cancelled']).optional(),
  clientOrderId: orderSchema.shape.clientOrderId,
});
function query<S extends z.ZodType>(c: Ctx, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? '查询参数无效');
  return result.data;
}

export function tradingRoutes({ db, config, now }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/trading/account', (c) => {
    const user = requireUser(c);
    return c.json({
      user: toMe(getUserById(db, user.id)!, config, now()),
      stats: userStatsAndRank(db, user.id).stats,
      positions: exchangePortfolio(db, user.id, now()),
      openOrders: exchangePortfolioOrders(db, user.id),
    });
  });
  app.get('/trading/positions', (c) => c.json(exchangePortfolio(db, requireUser(c).id, now())));
  app.get('/trading/orders', (c) => c.json(tradingOrders(db, requireUser(c).id, query(c, ordersQuery))));
  app.get('/trading/orders/:id', (c) => c.json(ownedOrder(db, requireUser(c).id, parseId(c.req.param('id')))));
  app.post('/trading/orders', async (c) => {
    const user = requireUser(c);
    const input = await parseBody(c, tradingOrderSchema);
    const order = placeOrder(db, user.id, input.marketId, input, now());
    return c.json(ownedOrder(db, user.id, order.id), 201);
  });
  app.post('/trading/orders/:id/cancel', (c) => {
    const user = requireUser(c);
    const order = ownedOrder(db, user.id, parseId(c.req.param('id')));
    // Retrying a successfully cancelled order must not release its assets twice.
    if (order.status !== 'cancelled') cancelOrder(db, user.id, order.marketId, order.id, now());
    return c.json(ownedOrder(db, user.id, order.id));
  });
  app.get('/trading/trades', (c) => c.json(tradingFills(db, requireUser(c).id, query(c, pageQuery))));
  app.get('/trading/markets/:id/book', (c) => {
    const id = parseId(c.req.param('id'));
    const state = exchangeState(db, id, now());
    return c.json({
      marketId: id,
      status: derivedStatus(getMarketRow(db, id), now()),
      collateral: state.collateral,
      books: state.books,
      serverTime: now(),
    });
  });
  app.get('/trading/markets/:id/trades', (c) =>
    c.json(marketTrades(db, parseId(c.req.param('id')), query(c, pageQuery))),
  );
  for (const action of ['split', 'merge'] as const) {
    app.post(`/trading/markets/:id/${action}`, async (c) => {
      const user = requireUser(c);
      const id = parseId(c.req.param('id'));
      const input = await parseBody(c, shareAmountSchema);
      splitMerge(db, user.id, id, input.quantity, action, now(), input.outcomeId);
      return c.json({
        balance: toMe(getUserById(db, user.id)!, config, now()).balance,
        ...exchangeState(db, id, now(), user.id),
      });
    });
  }
  app.post('/trading/markets/:id/convert', async (c) => {
    const user = requireUser(c);
    const id = parseId(c.req.param('id'));
    const input = await parseBody(c, convertSchema);
    convertShares(db, user.id, id, input.outcomeIds, input.quantity, now());
    return c.json({
      balance: toMe(getUserById(db, user.id)!, config, now()).balance,
      ...exchangeState(db, id, now(), user.id),
    });
  });
  return app;
}
