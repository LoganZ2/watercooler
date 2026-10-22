import type { WerewolfGameSummary } from '@watercooler/shared';
import type { Play } from '../bots/llm';
import type { DB } from '../db';
import { MINUTE } from '../lib/time';
import { playGame, ReplayMismatch, Stopped } from './engine';
import { abortGame, createGame, currentGame, gameSummary, marketsCancelled, startGame } from './game';

export interface WerewolfDeps {
  db: DB;
  play: Play;
  now: () => number;
  log: (m: string) => void;
  /** Seats for new games. */
  players: number;
  /** Break after a game; the next game's bets are open meanwhile. */
  restMs: number;
  /** Least time between two things the audience sees, and from nightfall to dawn. */
  paceMs?: number;
  nightMs?: number;
  random?: () => number;
}

export interface WerewolfService {
  stop(): void;
  /** For /admin: the current game, and why it is stuck if it is. */
  status(): { game: WerewolfGameSummary | null; problem: string | null };
}

/** A game that fails this many times in a row (not the model: a bug or bad data) is given up. */
const MAX_FAILURES = 3;

/**
 * Plays werewolf games one after another for as long as it runs: deal a table, wait out the
 * break, play it to the end, repeat. Stopping only pauses: the game in progress resumes from its
 * recorded events when the service starts again.
 */
export function startWerewolf(deps: WerewolfDeps): WerewolfService {
  const { db, now, log } = deps;
  const random = deps.random ?? Math.random;
  let stopped = false;
  let problem: string | null = null;
  const pending = new Set<() => void>();

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (stopped) return reject(new Stopped());
      const cancel = () => {
        clearTimeout(timer);
        reject(new Stopped());
      };
      const timer = setTimeout(
        () => {
          pending.delete(cancel);
          resolve();
        },
        Math.max(0, ms),
      );
      pending.add(cancel);
    });

  const engine = {
    db,
    play: deps.play,
    now,
    sleep,
    paceMs: deps.paceMs ?? 8_000,
    nightMs: deps.nightMs ?? 60_000,
    random,
    log,
    setProblem: (p: string | null) => {
      problem = p;
    },
  };

  async function loop(): Promise<void> {
    let failures = 0;
    let failedGame = 0;
    while (!stopped) {
      let gameId = 0;
      try {
        const game = currentGame(db) ?? createGame(db, deps.players, now() + deps.restMs, now(), random);
        gameId = game.id;
        if (game.status === 'waiting') {
          await sleep(game.starts_at - now());
          startGame(db, game.id, now());
          log(`🐺 werewolf game ${game.id} started`);
        }
        // Paused so long that its markets timed out and were refunded: nothing left to play for.
        if (marketsCancelled(db, game.id)) {
          abortGame(db, game.id, '这局狼人杀没能继续，押注全部退还', now());
          continue;
        }
        await playGame(engine, game.id);
        log(`🐺 werewolf game ${gameId} ended`);
        problem = null;
      } catch (err) {
        if (err instanceof Stopped) return;
        const message = err instanceof Error ? err.message : String(err);
        log(`[werewolf] game ${gameId} failed: ${message}`);
        failures = failedGame === gameId ? failures + 1 : 1;
        failedGame = gameId;
        if (gameId && (err instanceof ReplayMismatch || failures >= MAX_FAILURES)) {
          abortGame(db, gameId, '这局狼人杀出了故障没能打完，押注全部退还', now());
          problem = null;
          continue;
        }
        problem = `出错了：${message}`;
        await sleep(MINUTE).catch(() => {});
      }
    }
  }

  void loop();

  return {
    stop() {
      stopped = true;
      for (const cancel of pending) cancel();
      pending.clear();
    },
    status() {
      const game = currentGame(db);
      return { game: game ? gameSummary(db, game, now()) : null, problem };
    },
  };
}
