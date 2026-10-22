import type Anthropic from '@anthropic-ai/sdk';
import { CURRENCY_NAME } from '@watercooler/shared';
import type { Chat } from '../bots/llm';
import { getUserById } from '../services/users';
import { chatTools, formatTime, RULES, runTool, type ToolContext } from './tools';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Model calls per message; each round can run several tools. */
const MAX_ROUNDS = 8;
/** Stop starting new model calls after this long, so a reply never hangs for many minutes. */
const TIME_BUDGET = 3 * 60_000;

/** What the bot is doing, shown in the streamed "思考中…" line while tools run. */
const TOOL_PROGRESS: Record<string, string> = {
  list_markets: '查市场',
  get_market: '看市场详情',
  my_account: '查账户',
  leaderboard: '看排行榜',
  claim_daily_bonus: '签到',
  place_bet: '准备下注',
  get_order_book: '看盘口',
  place_order: '准备下单',
  cancel_order: '准备撤单',
  create_market: '准备开盘',
  resolve_market: '准备公布结果',
  cancel_market: '准备取消市场',
};

function systemPrompt(ctx: ToolContext, siteName: string): string {
  const user = getUserById(ctx.db, ctx.userId)!;
  return `你是「${siteName}」的企业微信群聊助手。${siteName} 是同事之间用虚拟币「${CURRENCY_NAME}」玩的预测市场，不涉及真钱。
你正在和 ${user.display_name}（网站用户名 ${user.username}）对话，所有工具都以这个用户的身份操作。现在是 ${formatTime(ctx.now, ctx.config.timezone)}（${ctx.config.timezone}）。

${RULES}

怎么做：
- 用工具查真实数据再回答，不要编造市场、赔率或余额。市场 id 只用来调用工具，回复里用问题标题称呼市场。
- 下注、Polymarket 下单和撤单、开盘、公布结果、取消市场都要调用对应的工具，它会发确认卡片，用户点「确认」才会执行；一条消息只能发一张卡片。金额、选项、份额、哪个市场没说清楚时先问清楚，不要猜。
- Polymarket 市场：说"买 X 块钱的 Yes"就用市价单按金额买；说了价格就用限价单。先用 get_market 或 get_order_book 看盘口再报价。
- 帮用户开盘时把问题写清楚、可判定，截止时间要合理，规则说明写明以什么为准。
- 每日签到可以直接帮用户领。
- 不能替别人操作，也不能动别人建的盘。和预测市场无关的问题简短回答即可。
- 用简体中文，简短，适合在群里看：可以用 **加粗**、列表和链接，不要用表格和标题。`;
}

/**
 * Answer one message: let the model call tools until it writes a reply. A money action leaves a
 * confirmation card in `ctx.card` for the caller to send.
 */
export async function runChat(
  chat: Chat,
  ctx: ToolContext,
  siteName: string,
  history: ChatTurn[],
  text: string,
  onProgress: (status: string) => void = () => {},
): Promise<string> {
  const system = systemPrompt(ctx, siteName);
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: 'user', content: text }];
  const started = Date.now();
  for (let round = 0; round < MAX_ROUNDS && Date.now() - started < TIME_BUDGET; round++) {
    const response = await chat({ system, messages, tools: chatTools });
    if (response.stop_reason === 'refusal') return '这个我没法回答，换个问题吧。';
    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) {
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return reply || (ctx.card ? '请点下面的卡片确认。' : '嗯？没太明白，再说一次？');
    }
    onProgress([...new Set(calls.map((c) => TOOL_PROGRESS[c.name] ?? '处理'))].join('、'));
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: calls.map((call) => {
        const result = runTool(ctx, call.name, call.input);
        return { type: 'tool_result', tool_use_id: call.id, content: result.content, is_error: result.isError };
      }),
    });
  }
  return ctx.card ? '请点下面的卡片确认。' : '这个有点复杂，我没处理完，换个说法试试？';
}
