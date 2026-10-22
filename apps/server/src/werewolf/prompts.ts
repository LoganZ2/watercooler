import type { SubmitTool } from '../bots/llm';
import { boardText, eventLine, ROLE_NAME, seatName, type GameEvent, type SeatInfo } from './rules';

/** Every call offers the same single tool, so the cached prefix (tools, system, log) is shared. */
export const ACT_TOOL: SubmitTool = {
  name: 'act',
  description: '提交你这一步的行动。每次轮到你都必须调用一次。',
  input_schema: {
    type: 'object',
    properties: {
      thought: {
        type: 'string',
        description: '你此刻真实的想法和判断，100 字以内。游戏结束前谁也看不到，结束后公开给观众复盘。',
      },
      speech: {
        type: 'string',
        description: '说出口的话：白天发言、遗言，或狼人夜里对队友说的话。其他行动可以不填。',
      },
      target: {
        type: 'integer',
        description: '选择的座位号：投票、刀人、查验、毒人或开枪的对象。0 表示弃票、不毒或不开枪。',
      },
      save: { type: 'boolean', description: '仅女巫：是否用解药救今晚被刀的人。' },
    },
    required: ['thought'],
  },
};

/** Rules and the table, identical for every player of a game. */
export function systemPrompt(seats: SeatInfo[]): string {
  const roles = boardText(seats.map((s) => s.role));
  const hasHunter = seats.some((s) => s.role === 'hunter');
  return `你在参加一局狼人杀，同桌都是 AI 玩家，观众在旁边看直播。

## 本局
共 ${seats.length} 人：${roles}。座位和每个人的风格：
${seats.map((s) => `- ${seatName(seats, s.seat)}：${s.persona}`).join('\n')}

## 规则
- 夜里：狼人商量后刀一名玩家；预言家查验一名玩家是不是狼人；女巫有一瓶解药和一瓶毒药，各只能用一次，解药只能救当晚被刀的人且不能救自己，同一晚不能两瓶都用。
- 天亮后公布昨晚出局的人，不公布身份和死因。只有第一夜出局的人留遗言。
- 白天从死者的下一位（平安夜从 1 号）开始依次发言，然后所有活着的人同时投票，得票最多的人被放逐并留遗言；平票无人出局，可以弃票。${hasHunter ? '\n- 猎人被狼人刀死或被放逐时可以亮身份开枪带走一人；被毒死不能开枪。' : ''}
- 出局的人身份在游戏结束前不公开。
- 狼人全部出局，好人胜利。平民全部出局、或神职（预言家、女巫${hasHunter ? '、猎人' : ''}）全部出局、或活着的狼人不少于活着的好人，狼人胜利。

## 怎么玩
- 你只知道自己身份能知道的信息。好人要找出狼人；狼人要隐藏身份，可以伪装、悍跳预言家、误导好人。
- 发言像真人玩家：有立场、有推理、有情绪，符合你的风格；可以跳身份、报查验、怀疑或保人。每次发言 50 到 200 字，中文口语，不要 markdown、列表或表情符号，称呼别人用「X 号」。
- 不要提到你是 AI，也不要提观众或下注。
- 每次轮到你，都调用 act 工具提交行动：thought 写真实想法，其他字段按当时的要求填写。`;
}

/** The public log as blocks, oldest first: the part every player's call shares. */
export const transcript = (events: GameEvent[], seats: SeatInfo[]): string[] =>
  events.filter((e) => e.public).map((e) => eventLine(e, seats));

export interface View {
  seats: SeatInfo[];
  seat: SeatInfo;
  alive: ReadonlySet<number>;
  events: GameEvent[];
  antidote: boolean;
  poison: boolean;
}

/** What only this player knows: role, wolf teammates and talk, checks, potions. */
function privateView({ seats, seat, events, antidote, poison }: View): string {
  const lines = [`你是 ${seatName(seats, seat.seat)}，身份是「${ROLE_NAME[seat.role]}」。`];
  if (seat.role === 'wolf') {
    const mates = seats.filter((s) => s.role === 'wolf' && s.seat !== seat.seat);
    lines.push(
      mates.length ? `你的狼队友：${mates.map((s) => seatName(seats, s.seat)).join('、')}。` : '你没有狼队友。',
    );
    const talk = events.filter((e) => e.kind === 'wolf' || e.kind === 'kill');
    if (talk.length) lines.push('狼队夜里的记录：', ...talk.map((e) => `- 第 ${e.day} 夜 ${eventLine(e, seats)}`));
  }
  if (seat.role === 'seer') {
    const checks = events.filter((e) => e.kind === 'seer');
    lines.push(
      checks.length
        ? `你的查验结果：${checks.map((e) => `第 ${e.day} 夜 ${e.target} 号是${e.data.wolf ? '狼人' : '好人'}`).join('；')}。`
        : '你还没有查验过任何人。',
    );
  }
  if (seat.role === 'witch') {
    lines.push(`你的药：解药${antidote ? '还在' : '已用'}，毒药${poison ? '还在' : '已用'}。`);
    const used = events.filter((e) => e.kind === 'witch' && (e.data.save || e.target !== null));
    if (used.length) lines.push(...used.map((e) => `- 第 ${e.day} 夜 ${eventLine(e, seats)}`));
  }
  if (seat.role === 'hunter') lines.push('你被狼人刀死或被放逐时可以开枪带走一人，被毒死则不能开枪。');
  return lines.join('\n');
}

const seatsText = (seats: number[]) => (seats.length ? seats.map((s) => `${s} 号`).join('、') : '无');

/** The prompt after the shared log: the player's own view, then what to do now. */
export function turnPrompt(view: View, task: string): string {
  const alive = [...view.alive].sort((a, b) => a - b);
  return `以上是到目前为止所有人都看到的公开记录。

${privateView(view)}
场上还活着：${seatsText(alive)}。

${task}`;
}

export const TASKS = {
  wolf: (day: number, targets: number[], proposals: { seat: number; target: number; text: string }[]) =>
    `现在是第 ${day} 夜，狼人行动。${
      proposals.length
        ? `队友已经说了：${proposals.map((p) => `${p.seat} 号「${p.text || '……'}」提议刀 ${p.target} 号`).join('；')}。`
        : '你第一个发言。'
    }可以刀的人：${seatsText(targets)}。speech 写你对队友说的一两句话，target 填你提议刀的座位号。`,
  seer: (day: number, targets: number[]) =>
    `现在是第 ${day} 夜，你可以查验一名玩家。可查验：${seatsText(targets)}。target 填座位号。`,
  witch: (day: number, victim: number, antidote: boolean, poison: boolean, targets: number[]) =>
    `现在是第 ${day} 夜，女巫行动。${
      antidote
        ? `今晚被刀的是 ${victim} 号，save 填 true 表示用解药救他（不能救自己）。`
        : '你的解药已经用掉，看不到今晚谁被刀。'
    }${
      poison ? `target 填要毒的座位号（可选：${seatsText(targets)}），0 表示不毒。` : '你的毒药已经用掉。'
    }同一晚只能用一瓶药。`,
  speech: (day: number, order: number[]) =>
    `现在是第 ${day} 天白天，发言顺序：${seatsText(order)}，轮到你发言。speech 填你的发言，50 到 200 字。`,
  lastWords: () => '你出局了，请留遗言。speech 填你的遗言，50 到 200 字。',
  vote: (day: number, targets: number[]) =>
    `第 ${day} 天的发言结束，开始投票，所有人同时投、互相看不到。可投：${seatsText(targets)}。target 填座位号，0 表示弃票。`,
  hunter: (targets: number[]) =>
    `你出局了，你是猎人，可以亮身份开枪带走一人。可选：${seatsText(targets)}。target 填座位号，0 表示不开枪。`,
};
