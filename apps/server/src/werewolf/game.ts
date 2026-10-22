import {
  fromCents,
  werewolfCutoff,
  type WerewolfEvent,
  type WerewolfGame,
  type WerewolfGameSummary,
  type WerewolfLobby,
  type WerewolfRole,
  type WerewolfSide,
} from '@watercooler/shared';
import type { DB } from '../db';
import { notFound } from '../lib/http';
import { DAY } from '../lib/time';
import { cancelMarket, resolveMarket } from '../services/bets';
import { createMarket, getOutcomeRows, werewolfMarkets, type MarketRow } from '../services/markets';
import { systemUser } from '../services/users';
import { deal, deathsOf, eventLine, roleSet, SIDE_NAME, type EventData, type GameEvent, type SeatInfo } from './rules';

/**
 * AI werewolf games in the database. A game's bets are pool markets created by the judge account:
 * which side wins, and for every seat whether that player is out by the end. A seat's market
 * settles the moment the player is out; betting on everything stops once at most `cutoff`
 * players are alive, and the rest settles when the game ends.
 */

export interface GameRow {
  id: number;
  status: 'waiting' | 'running' | 'ended' | 'aborted';
  players: number;
  cutoff: number;
  /** SeatInfo[] as JSON, roles included: never sent to browsers before the game is over. */
  seats: string;
  starts_at: number;
  started_at: number | null;
  ended_at: number | null;
  winner: WerewolfSide | null;
  betting_closed_at: number | null;
  created_at: number;
}

interface EventRow {
  id: number;
  game_id: number;
  day: number;
  kind: GameEvent['kind'];
  seat: number | null;
  target: number | null;
  text: string;
  thought: string | null;
  data: string | null;
  public: 0 | 1;
  created_at: number;
}

export type StoredEvent = GameEvent & { id: number; createdAt: number };

/** Markets stay open this long at most, in case a game is paused (flag off) before it ends. */
const BETTING_WINDOW = DAY;

/** The account that creates and settles the games' markets. */
export const judgeId = (db: DB, now: number) => systemUser(db, 'werewolf.host', 'werewolf', '狼人杀法官', now);

export function getGame(db: DB, id: number): GameRow {
  const row = db.prepare('SELECT * FROM werewolf_games WHERE id = ?').get(id) as GameRow | undefined;
  if (!row) throw notFound('这局狼人杀不存在');
  return row;
}

export const seatsOf = (g: Pick<GameRow, 'seats'>): SeatInfo[] => JSON.parse(g.seats) as SeatInfo[];

export function gameEvents(db: DB, gameId: number): StoredEvent[] {
  const rows = db.prepare('SELECT * FROM werewolf_events WHERE game_id = ? ORDER BY id').all(gameId) as EventRow[];
  return rows.map((r) => ({
    id: r.id,
    day: r.day,
    kind: r.kind,
    seat: r.seat,
    target: r.target,
    text: r.text,
    thought: r.thought,
    data: r.data ? (JSON.parse(r.data) as EventData) : {},
    public: r.public === 1,
    createdAt: r.created_at,
  }));
}

export function insertEvents(db: DB, gameId: number, events: GameEvent[], now: number): void {
  const insert = db.prepare(
    `INSERT INTO werewolf_events (game_id, day, kind, seat, target, text, thought, data, public, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of events)
    insert.run(
      gameId,
      e.day,
      e.kind,
      e.seat,
      e.target,
      e.text,
      e.thought,
      Object.keys(e.data).length ? JSON.stringify(e.data) : null,
      e.public ? 1 : 0,
      now,
    );
}

/** The game being played or waiting to start, if any. */
export function currentGame(db: DB): GameRow | undefined {
  return db
    .prepare(`SELECT * FROM werewolf_games WHERE status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1`)
    .get() as GameRow | undefined;
}

/** Deal a new table and open its bets; it starts at `startsAt`. */
export function createGame(
  db: DB,
  players: number,
  startsAt: number,
  now: number,
  random: () => number = Math.random,
): GameRow {
  return db.transaction(() => {
    const seats = deal(players, random);
    const cutoff = werewolfCutoff(players);
    const id = Number(
      db
        .prepare(
          `INSERT INTO werewolf_games (status, players, cutoff, seats, starts_at, created_at)
           VALUES ('waiting', ?, ?, ?, ?, ?)`,
        )
        .run(players, cutoff, JSON.stringify(seats), startsAt, now).lastInsertRowid,
    );
    const judge = judgeId(db, now);
    const rules = `${players} 个 AI 玩家的狼人杀，身份到游戏结束才公开，发言实时直播。场上只剩 ${cutoff} 人时停止下注，结果一出就结算。奖池模式：押中的人按比例分走整个奖池，没人押中则全部退还。`;
    const tag = db.prepare('UPDATE markets SET werewolf_game_id = ?, werewolf_seat = ? WHERE id = ?');
    const open = (question: string, description: string, outcomes: string[], seat: number | null) => {
      const marketId = createMarket(
        db,
        judge,
        { question, description, category: '娱乐', closeAt: startsAt + BETTING_WINDOW, mode: 'pool', outcomes },
        now,
      );
      tag.run(id, seat, marketId);
    };
    open(
      `AI 狼人杀第 ${id} 局：好人还是狼人获胜？`,
      `${rules}\n\n狼人全部出局则好人胜；平民全部出局、神职全部出局或狼人不少于好人则狼人胜。`,
      ['好人', '狼人'],
      null,
    );
    for (const s of seats)
      open(
        `AI 狼人杀第 ${id} 局：${s.seat} 号「${s.name}」会出局吗？`,
        `${rules}\n\n「出局」：游戏结束前被刀、被毒、被放逐或被猎人带走；「存活」：活到游戏结束。`,
        ['出局', '存活'],
        s.seat,
      );
    return getGame(db, id);
  })();
}

export function startGame(db: DB, id: number, now: number): void {
  db.prepare(`UPDATE werewolf_games SET status = 'running', started_at = ? WHERE id = ? AND status = 'waiting'`).run(
    now,
    id,
  );
}

function gameMarketRows(db: DB, gameId: number): MarketRow[] {
  return db
    .prepare('SELECT * FROM markets WHERE werewolf_game_id = ? ORDER BY werewolf_seat IS NOT NULL, werewolf_seat')
    .all(gameId) as MarketRow[];
}

/** Settle an open market on its outcome at `index`; settled or cancelled ones are left alone. */
function settle(db: DB, market: MarketRow, index: number, note: string, now: number): void {
  if (market.status !== 'open') return;
  resolveMarket(db, market.id, getOutcomeRows(db, market.id)[index]!.id, market.creator_id, note, now);
}

/** Seats just announced out: their markets settle on 出局, and betting stops at the cutoff. */
export function seatsOut(db: DB, gameId: number, out: number[], alive: number, note: string, now: number): void {
  const markets = gameMarketRows(db, gameId);
  for (const seat of out) {
    const market = markets.find((m) => m.werewolf_seat === seat);
    if (market) settle(db, market, 0, note, now);
  }
  const game = getGame(db, gameId);
  if (alive <= game.cutoff && game.betting_closed_at === null) {
    db.prepare('UPDATE werewolf_games SET betting_closed_at = ? WHERE id = ?').run(now, gameId);
    db.prepare(`UPDATE markets SET close_at = ? WHERE werewolf_game_id = ? AND status = 'open' AND close_at > ?`).run(
      now,
      gameId,
      now,
    );
  }
}

/** The end: survivors settle on 存活 and the side market on the winner. */
export function finishGame(db: DB, gameId: number, winner: WerewolfSide, now: number): void {
  for (const m of gameMarketRows(db, gameId)) {
    if (m.werewolf_seat === null) settle(db, m, winner === 'good' ? 0 : 1, `${SIDE_NAME[winner]}胜利`, now);
    else settle(db, m, 1, '活到了游戏结束', now);
  }
  db.prepare(`UPDATE werewolf_games SET status = 'ended', winner = ?, ended_at = ? WHERE id = ?`).run(
    winner,
    now,
    gameId,
  );
}

/** A game that cannot be finished: every bet still open is refunded. */
export function abortGame(db: DB, gameId: number, note: string, now: number): void {
  db.transaction(() => {
    for (const m of gameMarketRows(db, gameId)) if (m.status === 'open') cancelMarket(db, m.id, null, note, now);
    db.prepare(`UPDATE werewolf_games SET status = 'aborted', ended_at = ? WHERE id = ?`).run(now, gameId);
  })();
}

/** Whether any of the game's markets was cancelled from outside (e.g. overdue after a long pause). */
export const marketsCancelled = (db: DB, gameId: number): boolean =>
  db.prepare(`SELECT 1 FROM markets WHERE werewolf_game_id = ? AND status = 'cancelled'`).get(gameId) !== undefined;

function phaseOf(g: GameRow, events: StoredEvent[]): { day: number; phase: string } {
  const last = events.filter((e) => e.public).at(-1);
  const day = last?.day ?? 0;
  if (g.status === 'waiting') return { day, phase: '等待开局' };
  if (g.status === 'aborted') return { day, phase: '已中止，下注全部退还' };
  if (g.status === 'ended') return { day, phase: `${g.winner ? SIDE_NAME[g.winner] : ''}胜利` };
  if (!last || last.kind === 'start') return { day, phase: '即将入夜' };
  if (last.kind === 'night') return { day, phase: `第 ${day} 夜` };
  if (last.kind === 'vote') return { day, phase: `第 ${day} 天 · 投票` };
  if (last.kind === 'speech') return { day, phase: `第 ${day} 天 · 发言` };
  return { day, phase: `第 ${day} 天` };
}

function summarize(db: DB, g: GameRow, events: StoredEvent[], now: number): WerewolfGameSummary {
  const { day, phase } = phaseOf(g, events);
  const side = gameMarketRows(db, g.id).find((m) => m.werewolf_seat === null);
  const pot = db.prepare('SELECT COALESCE(SUM(pot), 0) AS pot FROM markets WHERE werewolf_game_id = ?').get(g.id) as {
    pot: number;
  };
  return {
    id: g.id,
    status: g.status,
    players: g.players,
    cutoff: g.cutoff,
    alive: g.players - deathsOf(events.filter((e) => e.public)).size,
    day,
    phase,
    startsAt: g.starts_at,
    startedAt: g.started_at,
    endedAt: g.ended_at,
    winner: g.winner,
    bettingOpen: side !== undefined && side.status === 'open' && side.close_at > now,
    pot: fromCents(pot.pot),
  };
}

export function gameSummary(db: DB, g: GameRow, now: number): WerewolfGameSummary {
  return summarize(db, g, gameEvents(db, g.id), now);
}

/**
 * A game as people see it. While it runs only the public log is shown and roles stay hidden
 * (except a hunter who has fired); afterwards everything is, night actions and thoughts included.
 */
export function gameDetail(db: DB, id: number, now: number): WerewolfGame {
  const g = getGame(db, id);
  const seats = seatsOf(g);
  const all = gameEvents(db, id);
  const over = g.status === 'ended' || g.status === 'aborted';
  const shown = over ? all : all.filter((e) => e.public);
  const deaths = deathsOf(all.filter((e) => e.public));
  const fired = new Set(all.filter((e) => e.public && e.kind === 'hunter').map((e) => e.seat));
  const markets = werewolfMarkets(db, id, now);
  const counts = new Map<WerewolfRole, number>();
  for (const r of roleSet(g.players)) counts.set(r, (counts.get(r) ?? 0) + 1);
  const spoken = new Set(['speech', 'last_words', 'wolf']);
  // Numbered in the order shown: database ids would give away, by their gaps, how many hidden
  // night actions there were, and so who is still alive.
  const events: WerewolfEvent[] = shown.map((e, i) => ({
    id: i + 1,
    day: e.day,
    kind: e.kind,
    seat: e.seat,
    target: e.target,
    text: spoken.has(e.kind) ? e.text : eventLine(e, seats),
    thought: over ? e.thought : null,
    public: e.public,
    createdAt: e.createdAt,
  }));
  return {
    ...summarize(db, g, all, now),
    roles: [...counts].map(([role, count]) => ({ role, count })),
    seats: seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      persona: s.persona,
      alive: !deaths.has(s.seat),
      diedDay: deaths.get(s.seat)?.day ?? null,
      death: deaths.get(s.seat)?.death ?? null,
      role: over || fired.has(s.seat) ? s.role : null,
      marketId: markets.find((m) => m.werewolf?.seat === s.seat)?.id ?? 0,
    })),
    events,
    sideMarket: markets.find((m) => m.werewolf?.seat === null)!,
    seatMarkets: markets.filter((m) => m.werewolf?.seat !== null),
  };
}

export function lobby(db: DB, enabled: boolean, now: number): WerewolfLobby {
  const current = currentGame(db);
  const recent = db
    .prepare(`SELECT * FROM werewolf_games WHERE status IN ('ended', 'aborted') ORDER BY id DESC LIMIT 20`)
    .all() as GameRow[];
  return {
    enabled,
    current: current ? gameSummary(db, current, now) : null,
    recent: recent.map((g) => gameSummary(db, g, now)),
  };
}

/** Whether there has ever been a game, so the AI zone shows up for it. */
export const gamesExist = (db: DB): boolean => db.prepare('SELECT 1 FROM werewolf_games LIMIT 1').get() !== undefined;
