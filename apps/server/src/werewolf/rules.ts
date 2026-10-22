import type { WerewolfRole, WerewolfSide } from '@watercooler/shared';

/**
 * The game itself, free of the database and the model: the board for a table size, who wins,
 * speaking order, votes and how each event reads. Rules follow the common Chinese 预女猎 board:
 * the wolves win by killing every villager or every god (屠边), or by reaching parity.
 */

export interface SeatInfo {
  seat: number;
  name: string;
  persona: string;
  role: WerewolfRole;
}

export const ROLE_NAME: Record<WerewolfRole, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  villager: '平民',
};

export const SIDE_NAME: Record<WerewolfSide, string> = { good: '好人', wolves: '狼人' };

const GODS: WerewolfRole[] = ['seer', 'witch', 'hunter'];

export const sideOf = (role: WerewolfRole): WerewolfSide => (role === 'wolf' ? 'wolves' : 'good');

/** A third of the table are wolves; seer and witch always, a hunter from 8 seats, villagers for the rest. */
export function roleSet(players: number): WerewolfRole[] {
  const wolves = Math.floor(players / 3);
  const gods: WerewolfRole[] = players >= 8 ? ['seer', 'witch', 'hunter'] : ['seer', 'witch'];
  return [
    ...Array.from({ length: wolves }, () => 'wolf' as const),
    ...gods,
    ...Array.from({ length: players - wolves - gods.length }, () => 'villager' as const),
  ];
}

/** 「3 狼人、预言家、女巫、猎人、3 平民」, always in this order so it says nothing about who sits where. */
export function boardText(roles: WerewolfRole[]): string {
  return (Object.keys(ROLE_NAME) as WerewolfRole[])
    .map((r) => [r, roles.filter((x) => x === r).length] as const)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => (n > 1 ? `${n} ${ROLE_NAME[r]}` : ROLE_NAME[r]))
    .join('、');
}

const NAMES = [
  '阿杰',
  '小鹿',
  '老周',
  '大橙',
  '米粒',
  '阿May',
  '豆豆',
  '老K',
  '小葵',
  '阿飞',
  '七七',
  '大熊',
  '糖糖',
  '阿泽',
  '小满',
  '老白',
  '皮皮',
  '阿宁',
  '可乐',
  '十一',
  '阿树',
  '桃子',
  '老陈',
  '小雨',
];

const PERSONAS = [
  '逻辑派，喜欢盘票型和发言顺序',
  '话不多，但每句都想说到点子上',
  '激进，爱带节奏、敢于冲锋',
  '谨慎，先听后说，不轻易站边',
  '幽默，爱开玩笑缓和气氛',
  '直觉派，常凭感觉站边',
  '老好人，容易相信别人',
  '咄咄逼人，喜欢质疑每一个人',
  '冷静，像个复盘的分析师',
  '新手，偶尔会犯迷糊',
  '演技派，说话很有感染力',
  '记仇，谁怀疑过他他就盯着谁',
];

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Seats 1..n with random names, playing styles and roles. */
export function deal(players: number, random: () => number = Math.random): SeatInfo[] {
  const roles = shuffle(roleSet(players), random);
  const names = shuffle(NAMES, random);
  const personas = shuffle(PERSONAS, random);
  return roles.map((role, i) => ({
    seat: i + 1,
    name: names[i % names.length]!,
    persona: personas[i % personas.length]!,
    role,
  }));
}

/** The side that has won with these seats alive, or null while the game goes on. */
export function winner(seats: SeatInfo[], alive: ReadonlySet<number>): WerewolfSide | null {
  const living = seats.filter((s) => alive.has(s.seat));
  const wolves = living.filter((s) => s.role === 'wolf').length;
  if (wolves === 0) return 'good';
  const villagers = living.filter((s) => s.role === 'villager').length;
  const gods = living.filter((s) => GODS.includes(s.role)).length;
  if (villagers === 0 || gods === 0 || wolves >= living.length - wolves) return 'wolves';
  return null;
}

/** Living seats clockwise, starting with the one after `after` (0 starts from seat 1). */
export function speakingOrder(players: number, alive: ReadonlySet<number>, after: number): number[] {
  const order: number[] = [];
  for (let k = 1; k <= players; k++) {
    const seat = ((after + k - 1) % players) + 1;
    if (alive.has(seat)) order.push(seat);
  }
  return order;
}

/** The most-voted seat, or null on a tie or when everyone abstained. */
export function tally(votes: { seat: number; target: number | null }[]): {
  exiled: number | null;
  counts: [number, number][];
} {
  const counts = new Map<number, number>();
  for (const v of votes) if (v.target !== null) counts.set(v.target, (counts.get(v.target) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const exiled = sorted.length > 0 && sorted[0]![1] !== sorted[1]?.[1] ? sorted[0]![0] : null;
  return { exiled, counts: sorted };
}

/** The wolves' kill: the most proposed seat, ties going to the one proposed first. */
export function wolfKill(proposals: { target: number }[]): number {
  const counts = new Map<number, number>();
  for (const p of proposals) counts.set(p.target, (counts.get(p.target) ?? 0) + 1);
  let best = proposals[0]!.target;
  for (const p of proposals) if (counts.get(p.target)! > counts.get(best)!) best = p.target;
  return best;
}

/** One recorded step of a game. */
export interface GameEvent {
  day: number;
  kind: EventKind;
  seat: number | null;
  target: number | null;
  /** Spoken words for speeches, last words and wolf talk; empty for the rest. */
  text: string;
  thought: string | null;
  data: EventData;
  public: boolean;
}

export type EventKind =
  | 'start'
  | 'night'
  | 'wolf'
  | 'kill'
  | 'seer'
  | 'witch'
  | 'dawn'
  | 'last_words'
  | 'hunter'
  | 'speech'
  | 'vote'
  | 'exile'
  | 'end';

export interface EventData {
  /** dawn: who is out this morning. */
  deaths?: number[];
  /** seer: whether the checked seat is a wolf. */
  wolf?: boolean;
  /** witch: whether she used the antidote on tonight's victim. */
  save?: boolean;
  /** exile: votes per seat, most first. */
  counts?: [number, number][];
  /** end: the winning side. */
  winner?: WerewolfSide;
}

/** How a seat is called in the log: 3 号「阿杰」. */
export const seatName = (seats: SeatInfo[], seat: number) =>
  `${seat} 号「${seats.find((s) => s.seat === seat)?.name ?? '?'}」`;

/** The event as one line of the game log; speeches are quoted after the speaker. */
export function eventLine(e: GameEvent, seats: SeatInfo[]): string {
  const who = (seat: number | null) => (seat === null ? '' : seatName(seats, seat));
  switch (e.kind) {
    case 'start':
      return `游戏开始。本局 ${seats.length} 人：${boardText(seats.map((s) => s.role))}。`;
    case 'night':
      return `第 ${e.day} 夜，天黑请闭眼。`;
    case 'wolf':
      return `（狼人夜聊）${who(e.seat)}：${e.text || '……'} 〔提议刀 ${e.target} 号〕`;
    case 'kill':
      return `狼人决定刀 ${who(e.target)}。`;
    case 'seer':
      return `预言家 ${who(e.seat)}查验 ${who(e.target)}：${e.data.wolf ? '狼人' : '好人'}。`;
    case 'witch': {
      const acts = [
        e.data.save ? '用解药救了今晚被刀的人' : null,
        e.target !== null ? `毒了 ${who(e.target)}` : null,
      ].filter(Boolean);
      return `女巫 ${who(e.seat)}${acts.length ? acts.join('，') : '没有用药'}。`;
    }
    case 'dawn': {
      const deaths = e.data.deaths ?? [];
      return deaths.length
        ? `第 ${e.day} 天，天亮了。昨晚 ${deaths.map(who).join('、')}出局。`
        : `第 ${e.day} 天，天亮了。昨晚是平安夜。`;
    }
    case 'last_words':
      return `${who(e.seat)}（遗言）：${e.text}`;
    case 'hunter':
      return e.target === null
        ? `${who(e.seat)}亮出猎人身份，选择不开枪。`
        : `${who(e.seat)}亮出猎人身份，开枪带走了 ${who(e.target)}。`;
    case 'speech':
      return `${who(e.seat)}：${e.text}`;
    case 'vote':
      return e.target === null ? `${who(e.seat)}弃票。` : `${who(e.seat)}投给 ${e.target} 号。`;
    case 'exile': {
      const counts = (e.data.counts ?? []).map(([seat, n]) => `${seat} 号 ${n} 票`).join('，');
      return e.target === null
        ? `投票结果：${counts || '全员弃票'}。平票，无人出局。`
        : `投票结果：${counts}。${who(e.target)}被放逐。`;
    }
    case 'end':
      return `游戏结束，${e.data.winner ? SIDE_NAME[e.data.winner] : '?'}胜利。`;
  }
}

/** Who is out, when and how, as far as the public log tells. */
export function deathsOf(
  events: Pick<GameEvent, 'kind' | 'day' | 'target' | 'data'>[],
): Map<number, { day: number; death: 'night' | 'exile' | 'shot' }> {
  const out = new Map<number, { day: number; death: 'night' | 'exile' | 'shot' }>();
  for (const e of events) {
    if (e.kind === 'dawn') for (const s of e.data.deaths ?? []) out.set(s, { day: e.day, death: 'night' });
    if (e.kind === 'exile' && e.target !== null) out.set(e.target, { day: e.day, death: 'exile' });
    if (e.kind === 'hunter' && e.target !== null) out.set(e.target, { day: e.day, death: 'shot' });
  }
  return out;
}
