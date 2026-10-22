import { describe, expect, it, vi } from 'vitest';
import type { Play } from '../src/bots/llm';
import type { DB } from '../src/db';
import { playGame, Stopped, type EngineDeps } from '../src/werewolf/engine';
import { createGame, currentGame, gameEvents, getGame, seatsOf, startGame } from '../src/werewolf/game';
import { startWerewolf } from '../src/werewolf/service';
import { boardText, deathsOf, roleSet, speakingOrder, tally, winner, type SeatInfo } from '../src/werewolf/rules';
import { setup } from './helpers';

const MINUTE = 60_000;

/** Math.random stand-in that deals the same table every time. */
function seeded(seed = 7) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * A model that plays by the book: wolves kill and vote the lowest good seat, good players vote
 * the lowest wolf (they peek at the roles), the witch keeps her potions.
 */
function fakeModel(seats: SeatInfo[]) {
  const calls: string[] = [];
  const role = (seat: number) => seats.find((s) => s.seat === seat)!.role;
  const listed = (prompt: string, label: string) => {
    const m = new RegExp(`${label}：([^。）]*)`).exec(prompt);
    return m ? [...m[1]!.matchAll(/(\d+) 号/g)].map((x) => Number(x[1])) : [];
  };
  const play: Play = async ({ prompt }) => {
    calls.push(prompt);
    const me = Number(/你是 (\d+) 号/.exec(prompt)![1]);
    if (prompt.includes('狼人行动'))
      return { thought: '刀最小号', speech: '刀他', target: listed(prompt, '可以刀的人')[0] };
    if (prompt.includes('你可以查验一名玩家')) return { thought: '查一下', target: listed(prompt, '可查验')[0] };
    if (prompt.includes('女巫行动')) return { thought: '先不用药', save: false, target: 0 };
    if (prompt.includes('开始投票')) {
      const options = listed(prompt, '可投');
      const pick = options.find((s) => (role(me) === 'wolf' ? role(s) !== 'wolf' : role(s) === 'wolf'));
      return { thought: '投他', target: pick ?? 0 };
    }
    if (prompt.includes('亮身份开枪带走一人')) return { thought: '带走', target: listed(prompt, '可选')[0] ?? 0 };
    return { thought: `${me} 号的想法`, speech: `我是 ${me} 号，我是好人，大家相信我。` };
  };
  return { play, calls };
}

function engine(db: DB, play: Play, now: () => number, sleep: EngineDeps['sleep'] = async () => {}): EngineDeps {
  return { db, play, now, sleep, paceMs: 0, nightMs: 0, random: seeded(3), log: () => {}, setProblem: () => {} };
}

function newGame(env: ReturnType<typeof setup>, players = 9) {
  const game = createGame(env.db, players, env.clock.now + 10 * MINUTE, env.clock.now, seeded());
  return { game, seats: seatsOf(game) };
}

const balance = (db: DB, username: string) =>
  (db.prepare('SELECT balance FROM users WHERE username = ?').get(username) as { balance: number }).balance;

describe('werewolf rules', () => {
  it('deals a third wolves, seer and witch, a hunter from 8 seats and villagers for the rest', () => {
    expect(roleSet(6).sort()).toEqual(['seer', 'villager', 'villager', 'witch', 'wolf', 'wolf']);
    const nine = roleSet(9);
    expect(nine.filter((r) => r === 'wolf')).toHaveLength(3);
    expect(nine.filter((r) => r === 'villager')).toHaveLength(3);
    expect(nine).toContain('hunter');
    expect(roleSet(12).filter((r) => r === 'wolf')).toHaveLength(4);
    // The board says nothing about who sits where.
    expect(boardText(['villager', 'wolf', 'witch', 'seer', 'wolf', 'villager'])).toBe('2 狼人、预言家、女巫、2 平民');
  });

  it('ends when the wolves are gone, a side is wiped out, or the wolves reach parity', () => {
    const seats: SeatInfo[] = (['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'] as const).map((role, i) => ({
      seat: i + 1,
      name: `p${i + 1}`,
      persona: '',
      role,
    }));
    expect(winner(seats, new Set([1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(winner(seats, new Set([3, 4, 5, 6]))).toBe('good');
    expect(winner(seats, new Set([1, 3, 4, 6]))).toBeNull();
    expect(winner(seats, new Set([1, 5, 6]))).toBe('wolves'); // gods gone
    expect(winner(seats, new Set([1, 3, 4]))).toBe('wolves'); // villagers gone
    expect(winner(seats, new Set([1, 2, 3, 5]))).toBe('wolves'); // parity
  });

  it('counts votes with ties exiling nobody and speaks clockwise after the dead', () => {
    expect(
      tally([
        { seat: 1, target: 2 },
        { seat: 2, target: 1 },
        { seat: 3, target: 2 },
      ]).exiled,
    ).toBe(2);
    expect(
      tally([
        { seat: 1, target: 2 },
        { seat: 2, target: 1 },
      ]).exiled,
    ).toBeNull();
    expect(tally([{ seat: 1, target: null }]).exiled).toBeNull();
    expect(speakingOrder(6, new Set([1, 2, 4, 5, 6]), 3)).toEqual([4, 5, 6, 1, 2]);
    expect(speakingOrder(6, new Set([1, 2, 3]), 0)).toEqual([1, 2, 3]);
  });
});

describe('werewolf games', () => {
  it('opens a side bet and one bet per seat, closes betting at half the table and settles everything', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const bob = await env.register('bob');
    const { game, seats } = newGame(env);
    expect(game.cutoff).toBe(5);

    const lobby = await alice.get('/werewolf');
    expect(lobby.body.current).toMatchObject({ id: game.id, status: 'waiting', players: 9, bettingOpen: true });
    const detail = (await alice.get(`/werewolf/${game.id}`)).body;
    expect(detail.seatMarkets).toHaveLength(9);
    expect(detail.sideMarket.outcomes.map((o: { label: string }) => o.label)).toEqual(['好人', '狼人']);
    expect(detail.seats.every((s: { role: unknown }) => s.role === null)).toBe(true);

    const [good, wolves] = detail.sideMarket.outcomes;
    await alice.post(`/markets/${detail.sideMarket.id}/bets`, { outcomeId: good.id, amount: 100 });
    await bob.post(`/markets/${detail.sideMarket.id}/bets`, { outcomeId: wolves.id, amount: 100 });
    for (const m of detail.seatMarkets) {
      await alice.post(`/markets/${m.id}/bets`, { outcomeId: m.outcomes[0].id, amount: 10 });
      await bob.post(`/markets/${m.id}/bets`, { outcomeId: m.outcomes[1].id, amount: 10 });
    }
    const before = balance(env.db, 'alice') + balance(env.db, 'bob');

    env.clock.now += 10 * MINUTE;
    startGame(env.db, game.id, env.clock.now);
    const { play } = fakeModel(seats);
    await playGame(
      engine(env.db, play, () => (env.clock.now += 1000)),
      game.id,
    );

    const ended = getGame(env.db, game.id);
    expect(ended.status).toBe('ended');
    const events = gameEvents(env.db, game.id);
    const dead = deathsOf(events.filter((e) => e.public));
    expect(winner(seats, new Set(seats.filter((s) => !dead.has(s.seat)).map((s) => s.seat)))).toBe(ended.winner);
    // Betting stopped the moment half the table was out, before the end.
    expect(ended.betting_closed_at).not.toBeNull();
    expect(ended.betting_closed_at!).toBeLessThanOrEqual(ended.ended_at!);

    const after = (await alice.get(`/werewolf/${game.id}`)).body;
    expect(after.sideMarket.status).toBe('resolved');
    expect(after.sideMarket.resolvedOutcomeId).toBe(ended.winner === 'good' ? good.id : wolves.id);
    for (const m of after.seatMarkets) {
      const seat = m.werewolf.seat as number;
      expect(m.status).toBe('resolved');
      expect(m.resolvedOutcomeId).toBe(m.outcomes[dead.has(seat) ? 0 : 1].id);
    }
    // Pool bets between the two of them: the money stays with them.
    expect(balance(env.db, 'alice') + balance(env.db, 'bob')).toBe(before + 100 * 100 * 2 + 9 * 10 * 100 * 2);
    // Roles, night actions and thoughts are out once the game is over.
    expect(after.seats.every((s: { role: unknown }) => s.role !== null)).toBe(true);
    expect(after.events.some((e: { kind: string }) => e.kind === 'kill')).toBe(true);
    expect(after.events.find((e: { kind: string }) => e.kind === 'speech').thought).toContain('的想法');
    expect(after.phase).toBe(ended.winner === 'good' ? '好人胜利' : '狼人胜利');
  });

  it('keeps roles, night actions and thoughts hidden while it runs, and resumes where it stopped', async () => {
    const env = setup();
    const viewer = await env.register('viewer');
    const { game, seats } = newGame(env);
    startGame(env.db, game.id, env.clock.now);
    const tick = () => (env.clock.now += 1000);

    // Stop partway through, the way a deploy or switching the flag off does.
    let commits = 0;
    const first = fakeModel(seats);
    await expect(
      playGame(
        engine(env.db, first.play, tick, async () => {
          if (++commits > 25) throw new Stopped();
        }),
        game.id,
      ),
    ).rejects.toBeInstanceOf(Stopped);

    const live = (await viewer.get(`/werewolf/${game.id}`)).body;
    expect(live.status).toBe('running');
    expect(live.events.length).toBeGreaterThan(0);
    expect(live.events.every((e: { public: boolean; thought: unknown }) => e.public && e.thought === null)).toBe(true);
    expect(live.events.some((e: { kind: string }) => e.kind === 'kill' || e.kind === 'wolf')).toBe(false);
    for (const s of live.seats) if (s.role !== null) expect(s.role).toBe('hunter');
    expect(JSON.stringify(live)).not.toContain('刀最小号');
    // Numbered as shown: gaps in database ids would count the hidden night actions.
    expect(live.events.map((e: { id: number }) => e.id)).toEqual(live.events.map((_: unknown, i: number) => i + 1));

    const second = fakeModel(seats);
    await playGame(engine(env.db, second.play, tick), game.id);
    expect(getGame(env.db, game.id).status).toBe('ended');

    // Same table played straight through: the same game, and the resumed run asked only for the rest.
    const env2 = setup();
    const { game: game2 } = newGame(env2);
    startGame(env2.db, game2.id, env2.clock.now);
    const straight = fakeModel(seats);
    await playGame(
      engine(env2.db, straight.play, () => (env2.clock.now += 1000)),
      game2.id,
    );
    const steps = (db: DB, id: number) => gameEvents(db, id).map((e) => [e.kind, e.seat, e.target]);
    expect(steps(env.db, game.id)).toEqual(steps(env2.db, game2.id));
    expect(second.calls.length).toBeLessThan(straight.calls.length);
    expect(first.calls.length + second.calls.length).toBeLessThanOrEqual(straight.calls.length + 9);
  });

  it('makes every night last the same minimum, however many players act in it', async () => {
    const env = setup();
    const { game, seats } = newGame(env);
    startGame(env.db, game.id, env.clock.now);
    await playGame(
      {
        ...engine(
          env.db,
          fakeModel(seats).play,
          () => (env.clock.now += 1000),
          async (ms) => {
            if (ms > 0) env.clock.now += ms;
          },
        ),
        nightMs: 90_000,
      },
      game.id,
    );
    const events = gameEvents(env.db, game.id);
    const nights = events.filter((e) => e.kind === 'night');
    expect(nights.length).toBeGreaterThan(1);
    for (const night of nights) {
      const dawn = events.find((e) => e.kind === 'dawn' && e.day === night.day)!;
      expect(dawn.createdAt - night.createdAt).toBeGreaterThanOrEqual(90_000);
      expect(dawn.createdAt - night.createdAt).toBeLessThan(92_000);
    }
  });

  it('rejects bets once betting has stopped', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const { game, seats } = newGame(env);
    startGame(env.db, game.id, env.clock.now);
    await playGame(
      engine(env.db, fakeModel(seats).play, () => (env.clock.now += 1000)),
      game.id,
    );
    const detail = (await alice.get(`/werewolf/${game.id}`)).body;
    expect(detail.bettingOpen).toBe(false);
    const res = await alice.post(`/markets/${detail.sideMarket.id}/bets`, {
      outcomeId: detail.sideMarket.outcomes[0].id,
      amount: 10,
    });
    expect(res.status).toBe(409);
  });

  it('falls back to a legal move when the model gives nothing usable, and waits out API errors', async () => {
    const env = setup();
    const { game } = newGame(env, 6);
    startGame(env.db, game.id, env.clock.now);
    let failures = 0;
    const problems: (string | null)[] = [];
    const waits: number[] = [];
    const play: Play = async () => {
      if (failures++ < 2) throw new Error('overloaded');
      return { nonsense: true };
    };
    await playGame(
      {
        ...engine(
          env.db,
          play,
          () => (env.clock.now += 1000),
          async (ms) => {
            waits.push(ms);
          },
        ),
        setProblem: (p) => problems.push(p),
      },
      game.id,
    );
    expect(problems.slice(0, 3)).toEqual(['模型调用失败：overloaded', '模型调用失败：overloaded', null]);
    expect(waits).toContain(15_000);
    expect(waits).toContain(30_000);
    const events = gameEvents(env.db, game.id);
    expect(getGame(env.db, game.id).status).toBe('ended');
    expect(events.filter((e) => e.kind === 'speech').every((e) => e.text === '（过）')).toBe(true);
    // Without votes nobody is exiled: the wolves' nightly kills decide it.
    expect(getGame(env.db, game.id).winner).toBe('wolves');
  });

  it('deals the next table as soon as a game ends, and only pauses when stopped', async () => {
    const env = setup();
    const service = startWerewolf({
      db: env.db,
      play: async () => ({}),
      now: () => (env.clock.now += 1000),
      log: () => {},
      players: 6,
      restMs: 10 * MINUTE,
      paceMs: 0,
      nightMs: 0,
    });
    // The first table waits out a break too; skip it.
    await vi.waitFor(() => expect(currentGame(env.db)?.status).toBe('waiting'));
    env.db.prepare('UPDATE werewolf_games SET starts_at = 0').run();
    service.stop();
    const again = startWerewolf({
      db: env.db,
      play: async () => ({}),
      now: () => (env.clock.now += 1000),
      log: () => {},
      players: 6,
      restMs: 10 * MINUTE,
      paceMs: 0,
      nightMs: 0,
    });
    try {
      await vi.waitFor(() => expect(getGame(env.db, 1).status).toBe('ended'), { timeout: 10_000 });
      await vi.waitFor(() => expect(currentGame(env.db)).toMatchObject({ id: 2, status: 'waiting' }));
      const next = currentGame(env.db)!;
      expect(next.starts_at - getGame(env.db, 1).ended_at!).toBeGreaterThanOrEqual(10 * MINUTE);
      expect(again.status().game).toMatchObject({ id: 2, status: 'waiting', bettingOpen: true });
    } finally {
      again.stop();
    }
  });

  it('keeps its markets and bets to itself', async () => {
    const env = setup();
    const alice = await env.register('alice');
    const { game } = newGame(env);
    const side = (await alice.get(`/werewolf/${game.id}`)).body.sideMarket;
    await alice.post(`/markets/${side.id}/bets`, { outcomeId: side.outcomes[0].id, amount: 10 });
    expect((await alice.get('/activity')).body).toHaveLength(0);
    expect((await alice.get('/markets')).body).toHaveLength(0);
    expect((await alice.get('/markets?zone=ai')).body).toHaveLength(0);
    expect((await alice.get('/markets?zone=any')).body).toHaveLength(0);
    expect((await alice.get('/stats')).body).toMatchObject({ openMarkets: 0, totalStaked: 0, bettors: 0 });
    expect((await alice.get('/markets?zone=werewolf')).body).toHaveLength(10);
    const config = (await alice.get('/config')).body;
    expect(config).toMatchObject({ aiZone: true, werewolf: false });
  });
});
