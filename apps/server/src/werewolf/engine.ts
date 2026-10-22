import type { Play } from '../bots/llm';
import type { DB } from '../db';
import { MINUTE } from '../lib/time';
import { finishGame, gameEvents, getGame, insertEvents, seatsOf, seatsOut } from './game';
import { ACT_TOOL, systemPrompt, TASKS, transcript, turnPrompt } from './prompts';
import {
  speakingOrder,
  tally,
  winner,
  wolfKill,
  type EventData,
  type EventKind,
  type GameEvent,
  type SeatInfo,
} from './rules';

/** Thrown out of a game when the service stops; the game resumes from its events later. */
export class Stopped extends Error {
  constructor() {
    super('stopped');
  }
}

/** The recorded events no longer fit the game's flow (the rules changed under a running game). */
export class ReplayMismatch extends Error {}

export interface EngineDeps {
  db: DB;
  play: Play;
  now: () => number;
  /** Waits, and rejects with Stopped once the service stops. */
  sleep: (ms: number) => Promise<void>;
  /** Least time between two things the audience sees, so they can follow and bet. */
  paceMs: number;
  /**
   * Least time from nightfall to dawn. Each living wolf, seer and witch adds a model call, so an
   * unpadded night would tell the audience by its length who is still alive.
   */
  nightMs: number;
  random: () => number;
  log: (m: string) => void;
  /** The model keeps failing (null once it answers again). */
  setProblem: (problem: string | null) => void;
}

/** Days after which a game is given up; with a kill every night but one it cannot get there. */
const MAX_DAYS = 20;
const SPEECH_LIMIT = 400;
const THOUGHT_LIMIT = 300;

interface Act {
  thought: string;
  speech: string;
  target: number | null;
  save: boolean;
}

/** Whatever the model passed to the act tool, read leniently; null when there is nothing usable. */
function readAct(raw: unknown): Act | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, limit: number) => (typeof v === 'string' ? v.trim().slice(0, limit) : '');
  const target = Number(r.target);
  return {
    thought: text(r.thought, THOUGHT_LIMIT),
    speech: text(r.speech, SPEECH_LIMIT),
    target: Number.isInteger(target) && target > 0 ? target : null,
    save: r.save === true || r.save === 'true',
  };
}

/** An event with the time it was recorded. */
type Stamped = GameEvent & { createdAt: number };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Play a game to its end. Every step is an event; the flow runs from the start each time and
 * steps already recorded are read back instead of asked again, so a restart (deploy, flag off and
 * on) resumes exactly where it stopped. Market effects are written in the same transaction as
 * the event that causes them.
 */
export async function playGame(deps: EngineDeps, gameId: number): Promise<void> {
  const { db, now } = deps;
  const game = getGame(db, gameId);
  const seats = seatsOf(game);
  const seatOf = (n: number) => seats.find((s) => s.seat === n)!;
  const recorded = gameEvents(db, gameId);
  let cursor = 0;
  const events: GameEvent[] = [];
  let lastShown = recorded.filter((e) => e.public).at(-1)?.createdAt ?? 0;

  const alive = new Set(seats.map((s) => s.seat));
  let antidote = true;
  let poison = true;
  const living = (keep: (s: SeatInfo) => boolean = () => true) => seats.filter((s) => alive.has(s.seat) && keep(s));
  const pick = (options: number[]) => options[Math.floor(deps.random() * options.length)]!;
  const system = systemPrompt(seats);

  const replaying = () => cursor < recorded.length;
  const take = (expect: Pick<GameEvent, 'kind' | 'seat'>): Stamped => {
    const e = recorded[cursor++]!;
    if (e.kind !== expect.kind || e.seat !== expect.seat)
      throw new ReplayMismatch(`expected ${expect.kind}/${expect.seat}, recorded ${e.kind}/${e.seat}`);
    events.push(e);
    return e;
  };

  /**
   * Record new events with their effects, or read them back. What the audience sees is paced, and
   * never shown before `notBefore`.
   */
  async function commit(batch: GameEvent[], effects?: (now: number) => void, notBefore = 0): Promise<Stamped[]> {
    if (replaying()) return batch.map(take);
    const shown = batch.some((e) => e.public);
    await deps.sleep(shown ? Math.max(lastShown + deps.paceMs, notBefore) - now() : 0);
    const t = now();
    db.transaction(() => {
      insertEvents(db, gameId, batch, t);
      effects?.(t);
    })();
    if (shown) lastShown = t;
    const stamped = batch.map((e) => ({ ...e, createdAt: t }));
    events.push(...stamped);
    return stamped;
  }

  const event = (day: number, kind: EventKind, seat: number | null, more: Partial<GameEvent> = {}): GameEvent => ({
    day,
    kind,
    seat,
    target: null,
    text: '',
    thought: null,
    data: {} as EventData,
    public: false,
    ...more,
  });

  /** One player's turn, asked of the model unless it is already recorded. */
  async function turn(
    spec: GameEvent,
    decide: () => Promise<Partial<GameEvent>>,
    effects?: (now: number, e: GameEvent) => void,
  ): Promise<GameEvent> {
    if (replaying()) return take(spec);
    const e = { ...spec, ...(await decide()) };
    await commit([e], effects && ((t) => effects(t, e)));
    return e;
  }

  /** Ask a player; API failures wait and retry (the game pauses), an unusable answer is asked once more. */
  async function ask(seat: SeatInfo, task: string): Promise<Act | null> {
    let failures = 0;
    for (let tries = 0; ;) {
      try {
        const raw = await deps.play({
          system,
          transcript: transcript(events, seats),
          prompt: turnPrompt({ seats, seat, alive, events, antidote, poison }, task),
          tool: ACT_TOOL,
        });
        deps.setProblem(null);
        const act = readAct(raw);
        if (act || ++tries >= 2) return act;
      } catch (err) {
        if (err instanceof Stopped) throw err;
        failures++;
        deps.setProblem(`模型调用失败：${errorText(err)}`);
        deps.log(`[werewolf] game ${gameId} seat ${seat.seat}: ${errorText(err)}`);
        await deps.sleep(Math.min(5 * MINUTE, 15_000 * 2 ** Math.min(failures - 1, 5)));
      }
    }
  }

  /** Seats out now: settle their markets and stop betting at the cutoff. */
  const out = (seatsGone: number[], note: string) => (t: number) =>
    seatsOut(db, gameId, seatsGone, [...alive].filter((s) => !seatsGone.includes(s)).length, note, t);

  async function ended(day: number): Promise<boolean> {
    const side = winner(seats, alive);
    if (!side) return false;
    await commit([event(day, 'end', null, { data: { winner: side }, public: true })], (t) =>
      finishGame(db, gameId, side, t),
    );
    return true;
  }

  async function lastWords(day: number, seat: number): Promise<void> {
    await turn(event(day, 'last_words', seat, { public: true }), async () => {
      const a = await ask(seatOf(seat), TASKS.lastWords());
      return { text: a?.speech || '（没有留下遗言）', thought: a?.thought || null };
    });
  }

  /** A dead hunter fires; true when that ends the game. */
  async function shoot(day: number, hunter: SeatInfo): Promise<boolean> {
    const options = living((s) => s.seat !== hunter.seat).map((s) => s.seat);
    const e = await turn(
      event(day, 'hunter', hunter.seat, { public: true }),
      async () => {
        const a = await ask(hunter, TASKS.hunter(options));
        return { target: a?.target && options.includes(a.target) ? a.target : null, thought: a?.thought || null };
      },
      (t, e) => {
        if (e.target !== null) out([e.target], `第 ${day} 天被猎人 ${hunter.seat} 号开枪带走`)(t);
      },
    );
    if (e.target === null) return false;
    alive.delete(e.target);
    return ended(day);
  }

  await commit([event(0, 'start', null, { public: true })]);

  for (let day = 1; day <= MAX_DAYS; day++) {
    const [night] = await commit([event(day, 'night', null, { public: true })]);

    // The wolves talk it over one after another; the most proposed seat is killed.
    const prey = living((s) => s.role !== 'wolf').map((s) => s.seat);
    const proposals: { seat: number; target: number; text: string }[] = [];
    for (const wolf of living((s) => s.role === 'wolf')) {
      const e = await turn(event(day, 'wolf', wolf.seat), async () => {
        const a = await ask(wolf, TASKS.wolf(day, prey, proposals));
        return {
          target: a?.target && prey.includes(a.target) ? a.target : pick(prey),
          text: a?.speech ?? '',
          thought: a?.thought || null,
        };
      });
      proposals.push({ seat: wolf.seat, target: e.target!, text: e.text });
    }
    const victim = wolfKill(proposals);
    await commit([event(day, 'kill', null, { target: victim })]);

    const seer = living((s) => s.role === 'seer')[0];
    if (seer) {
      const checked = new Set(events.filter((e) => e.kind === 'seer').map((e) => e.target));
      const options = living((s) => s.seat !== seer.seat && !checked.has(s.seat)).map((s) => s.seat);
      if (options.length)
        await turn(event(day, 'seer', seer.seat), async () => {
          const a = await ask(seer, TASKS.seer(day, options));
          const target = a?.target && options.includes(a.target) ? a.target : pick(options);
          return { target, data: { wolf: seatOf(target).role === 'wolf' }, thought: a?.thought || null };
        });
    }

    let saved = false;
    let poisoned: number | null = null;
    const witch = living((s) => s.role === 'witch')[0];
    if (witch && (antidote || poison)) {
      const canSave = antidote && victim !== witch.seat;
      const options = living((s) => s.seat !== witch.seat).map((s) => s.seat);
      const e = await turn(event(day, 'witch', witch.seat), async () => {
        const a = await ask(witch, TASKS.witch(day, victim, antidote, poison, options));
        const save = Boolean(a?.save) && canSave;
        const target = !save && poison && a?.target && options.includes(a.target) ? a.target : null;
        return { target, data: { save }, thought: a?.thought || null };
      });
      saved = Boolean(e.data.save);
      poisoned = e.target;
      if (saved) antidote = false;
      if (poisoned !== null) poison = false;
    }

    const deaths = [...new Set([saved ? null : victim, poisoned])]
      .filter((s): s is number => s !== null)
      .sort((a, b) => a - b);
    await commit(
      [event(day, 'dawn', null, { data: { deaths }, public: true })],
      out(deaths, `第 ${day} 夜出局`),
      night!.createdAt + deps.nightMs,
    );
    for (const d of deaths) alive.delete(d);
    if (await ended(day)) return;
    if (day === 1) for (const d of deaths) await lastWords(day, d);
    const hunter = deaths.map(seatOf).find((s) => s.role === 'hunter' && s.seat !== poisoned);
    if (hunter && (await shoot(day, hunter))) return;

    const order = speakingOrder(seats.length, alive, deaths[0] ?? 0);
    for (const seat of order)
      await turn(event(day, 'speech', seat, { public: true }), async () => {
        const a = await ask(seatOf(seat), TASKS.speech(day, order));
        return { text: a?.speech || '（过）', thought: a?.thought || null };
      });

    // Everyone votes at once, unaware of the others' votes; they are shown together.
    const voters = living();
    const votes = replaying()
      ? await commit(voters.map((v) => event(day, 'vote', v.seat, { public: true })))
      : await commit(
          await Promise.all(
            voters.map(async (v) => {
              const options = living((s) => s.seat !== v.seat).map((s) => s.seat);
              const a = await ask(v, TASKS.vote(day, options));
              const target = a?.target && options.includes(a.target) ? a.target : null;
              return event(day, 'vote', v.seat, { target, thought: a?.thought || null, public: true });
            }),
          ),
        );
    const { exiled, counts } = tally(votes.map((v) => ({ seat: v.seat!, target: v.target })));
    await commit(
      [event(day, 'exile', null, { target: exiled, data: { counts }, public: true })],
      exiled === null ? undefined : out([exiled], `第 ${day} 天被投票放逐`),
    );
    if (exiled === null) continue;
    alive.delete(exiled);
    if (await ended(day)) return;
    await lastWords(day, exiled);
    if (seatOf(exiled).role === 'hunter' && (await shoot(day, seatOf(exiled)))) return;
  }
  throw new Error(`第 ${gameId} 局过了 ${MAX_DAYS} 天还没结束`);
}
