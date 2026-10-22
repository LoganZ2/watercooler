import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../context';
import { parseId } from '../lib/http';
import { getFeatureFlags } from '../services/admin';
import { gameDetail, lobby } from '../werewolf/game';

/** The AI werewolf games: read-only; their bets go through the ordinary market routes. */
export function werewolfRoutes({ db, now }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/werewolf', (c) => c.json(lobby(db, getFeatureFlags(db).werewolf, now())));

  app.get('/werewolf/:id', (c) => c.json(gameDetail(db, parseId(c.req.param('id')), now())));

  return app;
}
