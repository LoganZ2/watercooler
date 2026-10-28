import type { Portfolio, UserProfile } from '@watercooler/shared';
import { Hono } from 'hono';
import { requireUser, type AppDeps, type AppEnv } from '../context';
import { notFound, parseId } from '../lib/http';
import { listBets } from '../services/bets';
import { exchangePortfolio, exchangePortfolioOrders } from '../services/exchange';
import { listMarkets } from '../services/markets';
import {
  leaderboard,
  siteStats,
  userBets,
  userLedger,
  userStatsAndRank,
  type LeaderboardSort,
} from '../services/stats';
import { getUserById, toPublicUser } from '../services/users';

export function userRoutes({ db, now }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/stats', (c) => c.json(siteStats(db, now())));

  app.get('/activity', (c) => c.json(listBets(db, { peopleOnly: true, limit: Number(c.req.query('limit')) || 30 })));

  app.get('/leaderboard', (c) => {
    const sort = c.req.query('sort');
    return c.json(leaderboard(db, sort === 'netWorth' || sort === 'bets' ? (sort as LeaderboardSort) : 'profit'));
  });

  app.get('/portfolio', (c) => {
    const user = requireUser(c);
    return c.json<Portfolio>({
      stats: userStatsAndRank(db, user.id).stats,
      bets: userBets(db, user.id, now()),
      exchangePositions: exchangePortfolio(db, user.id, now()),
      exchangeOrders: exchangePortfolioOrders(db, user.id),
    });
  });

  app.get('/portfolio/ledger', (c) => {
    const user = requireUser(c);
    const before = c.req.query('before');
    return c.json(userLedger(db, user.id, { before: before ? Number(before) : undefined }));
  });

  app.get('/users/:id', (c) => {
    const id = parseId(c.req.param('id'));
    const user = getUserById(db, id);
    if (!user) throw notFound('用户不存在');
    const t = now();
    const { stats, rank } = userStatsAndRank(db, id);
    return c.json<UserProfile>({
      user: toPublicUser(user),
      stats,
      rank,
      bets: userBets(db, id, t),
      recentBets: listBets(db, { userId: id, limit: 30 }),
      createdMarkets: listMarkets(db, t, { filter: 'all', zone: 'any', sort: 'new', creatorId: id, limit: 50 }),
    });
  });

  return app;
}
