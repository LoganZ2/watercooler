import type { Chat } from '../bots/llm';
import type { BotConfig } from '../bots/config';
import type { Config } from '../config';
import type { DB } from '../db';
import { HttpError } from '../lib/http';
import { RateLimiter } from '../lib/rateLimit';
import { HOUR, MINUTE } from '../lib/time';
import { getUserById, type UserRow } from '../services/users';
import { ACTION_TTL, executeAction, getAction, noticeCard, parseActionKey, setActionStatus } from './actions';
import {
  BIND_TOKEN_TTL,
  createBindToken,
  getBindingByWecom,
  touchBindingChat,
  unbindUser,
  type BindingRow,
} from './bindings';
import { runChat, type ChatTurn } from './chat';
import { startNotifier } from './notifier';
import { marketUrl, type ToolContext } from './tools';
import type { CardClick, IncomingText, WecomTransport } from './transport';

export type WecomSettings = NonNullable<BotConfig['wecom']>;

export interface WecomDeps {
  db: DB;
  config: Config;
  settings: WecomSettings;
  chat: Chat;
  transport: WecomTransport;
  now: () => number;
  log?: (m: string) => void;
}

export interface WecomService {
  /** Called after someone confirms a binding on the website: say so in the group the link came from. */
  announceBinding(binding: BindingRow, user: UserRow): void;
  /** Whether the long connection to WeCom is up and authenticated. */
  connected(): boolean;
  stop(): void;
}

/** Earlier messages kept per person and group, so follow-ups like "押 100 吧" make sense. */
const HISTORY_TURNS = 6;
const HISTORY_TTL = 30 * MINUTE;

const HELP = '@我 说说想干什么，比如「现在有什么盘」「我的余额」「在 xx 上押 100 是」「帮我开个盘：…」「签到」。';

/** Group messages start with "@机器人"; drop leading mentions. */
export const stripMentions = (text: string) => text.replace(/^(\s*@\S+)+/, '').trim();

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The WeCom bot: people bind their account from a group chat, then chat with the model to look
 * things up and to bet, open, resolve or cancel markets through confirmation cards.
 */
export function startWecom(deps: WecomDeps): WecomService {
  const { db, config, settings, transport } = deps;
  const log = deps.log ?? ((m: string) => console.log(`[wecom] ${m}`));
  const siteUrl = settings.siteUrl.replace(/\/+$/, '');
  const chatLimit = new RateLimiter(settings.messagesPerHour, HOUR);
  const linkLimit = new RateLimiter(5, BIND_TOKEN_TTL);
  const busy = new Set<string>();
  const histories = new Map<string, { turns: ChatTurn[]; at: number }>();

  const historyFor = (key: string, now: number): ChatTurn[] => {
    const h = histories.get(key);
    if (!h || now - h.at > HISTORY_TTL) return [];
    return h.turns;
  };
  const remember = (key: string, turns: ChatTurn[], now: number) => {
    histories.set(key, { turns: turns.slice(-HISTORY_TURNS), at: now });
    if (histories.size > 1000) {
      for (const [k, v] of histories) if (now - v.at > HISTORY_TTL) histories.delete(k);
    }
  };

  async function handleText(msg: IncomingText): Promise<void> {
    const now = deps.now();
    if (!msg.chatId) {
      await msg.reply('私聊不支持，请在群里 @我。', true);
      return;
    }
    const text = stripMentions(msg.text);
    const binding = getBindingByWecom(db, msg.userId);

    // Not bound: answer with a binding link and never reach the model.
    if (!binding) {
      if (!linkLimit.check(msg.userId, now)) {
        await msg.reply('绑定链接已经发过好几次了，请用最新的那个，或者过几分钟再试。', true);
        return;
      }
      linkLimit.hit(msg.userId, now);
      const token = createBindToken(db, msg.userId, msg.chatId, now);
      await msg.reply(
        `你还没有绑定 ${settings.siteName} 账号。[点这里绑定](${siteUrl}/bind/${token})\n` +
          `这个链接只给你本人用，${BIND_TOKEN_TTL / MINUTE} 分钟内有效、只能用一次。打开后登录并确认，再回来 @我 就能查盘、下注、开盘了。`,
        true,
      );
      return;
    }

    touchBindingChat(db, msg.userId, msg.chatId);
    const user = getUserById(db, binding.user_id)!;
    if (text === '解绑' || text === '解除绑定') {
      unbindUser(db, user.id);
      await msg.reply(`已解除和 ${settings.siteName} 账号「${user.display_name}」的绑定。`, true);
      return;
    }
    if (text === '绑定') {
      await msg.reply(`你已经绑定了「${user.display_name}」。要换账号先说「解绑」。`, true);
      return;
    }
    if (!text) {
      await msg.reply(HELP, true);
      return;
    }
    if (busy.has(msg.userId)) {
      await msg.reply('上一条还在处理，稍等一下。', true);
      return;
    }
    if (!chatLimit.check(msg.userId, now)) {
      await msg.reply('这一小时问得有点多了，歇一会儿再来吧。', true);
      return;
    }
    chatLimit.hit(msg.userId, now);

    busy.add(msg.userId);
    const key = `${msg.chatId}|${msg.userId}`;
    try {
      await msg.reply('思考中…', false);
      const ctx: ToolContext = { db, config, now, siteUrl, userId: user.id, wecomUserId: msg.userId, card: null };
      const history = historyFor(key, now);
      const reply = await runChat(deps.chat, ctx, settings.siteName, history, text, (status) => {
        msg.reply(`思考中…（${status}）`, false).catch(() => {});
      });
      await msg.reply(reply, true);
      if (ctx.card) await msg.replyCard(ctx.card);
      remember(key, [...history, { role: 'user', content: text }, { role: 'assistant', content: reply }], deps.now());
    } catch (err) {
      log(`chat failed: ${errorText(err)}`);
      await msg.reply('出了点问题，稍后再试。', true);
    } finally {
      busy.delete(msg.userId);
    }
  }

  async function handleClick(click: CardClick): Promise<void> {
    const parsed = parseActionKey(click.key);
    if (!parsed) return;
    const action = getAction(db, parsed.id);
    if (!action || action.task_id !== click.taskId) {
      await click.update(noticeCard(click.taskId, '这张卡片已失效'), [click.userId]);
      return;
    }
    // Only the person who asked may confirm; everyone else just gets told so, on their own screen.
    if (action.wecom_userid !== click.userId) {
      const owner = getUserById(db, action.user_id);
      await click.update(
        noticeCard(action.task_id, `只有${owner?.display_name ?? '发起人'}本人可以确认`, '想自己操作的话请 @我'),
        [click.userId],
      );
      return;
    }
    if (action.status !== 'pending') {
      await click.update(noticeCard(action.task_id, '这个操作已经处理过了'), [click.userId]);
      return;
    }
    const now = deps.now();
    if (!parsed.confirm) {
      setActionStatus(db, action.id, 'cancelled');
      await click.update(noticeCard(action.task_id, '已取消', '没有执行任何操作'));
      return;
    }
    if (now - action.created_at > ACTION_TTL) {
      setActionStatus(db, action.id, 'cancelled');
      await click.update(noticeCard(action.task_id, '确认卡片已过期', '没有执行，需要的话请重新 @我'));
      return;
    }
    // The WeCom account may have been unbound (or rebound) since the card was sent.
    if (getBindingByWecom(db, click.userId)?.user_id !== action.user_id) {
      setActionStatus(db, action.id, 'cancelled');
      await click.update(noticeCard(action.task_id, '绑定已变更，没有执行'));
      return;
    }
    try {
      const marketId = executeAction(db, action, now);
      const url = marketUrl(siteUrl, marketId);
      const done = {
        bet: '✅ 下注成功',
        create: '✅ 开盘成功',
        resolve: '✅ 已公布结果并结算',
        cancel: '✅ 已取消市场',
      }[action.kind];
      await click.update(noticeCard(action.task_id, done, '点开查看市场', url));
    } catch (err) {
      if (!(err instanceof HttpError)) log(`action ${action.id} failed: ${errorText(err)}`);
      if (getAction(db, action.id)?.status === 'pending') setActionStatus(db, action.id, 'failed');
      await click.update(
        noticeCard(action.task_id, '❌ 没有成功', err instanceof HttpError ? err.message : '服务器出错了'),
      );
    }
  }

  transport.onText((msg) => {
    handleText(msg).catch((err: unknown) => log(`message failed: ${errorText(err)}`));
  });
  transport.onCardClick((click) => {
    handleClick(click).catch((err: unknown) => log(`card click failed: ${errorText(err)}`));
  });
  const stopNotifier = startNotifier({ db, transport, siteUrl, now: deps.now, log });

  return {
    announceBinding(binding, user) {
      if (!binding.chat_id) return;
      transport
        .send(binding.chat_id, `✅ ${user.display_name} 绑定成功`)
        .catch((err: unknown) => log(`announce failed: ${errorText(err)}`));
    },
    connected: () => transport.ready(),
    stop() {
      stopNotifier();
      transport.close();
    },
  };
}
