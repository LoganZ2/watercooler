import { z } from 'zod';
import { MAX_BET, MAX_OUTCOMES, MIN_BET, MIN_MULTI_OUTCOMES, MIN_OUTCOMES, ORDER_TYPES, TOKENS } from './constants';

const username = z
  .string()
  .trim()
  .min(2, '用户名至少 2 个字符')
  .max(24, '用户名最多 24 个字符')
  .regex(/^[a-zA-Z0-9_.-]+$/, '用户名只能包含字母、数字、下划线、点和短横线');

const displayName = z.string().trim().min(1, '请填写昵称').max(24, '昵称最多 24 个字符');

const password = z.string().min(6, '密码至少 6 位').max(128, '密码最多 128 位');

export const registerSchema = z.object({
  username,
  displayName,
  password,
  inviteCode: z.string().trim().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入当前密码'),
  newPassword: password,
});

export const updateProfileSchema = z.object({ displayName });

const outcomeLabel = z.string().trim().min(1, '选项不能为空').max(40, '选项最多 40 个字符');

export const createMarketSchema = z
  .object({
    question: z.string().trim().min(5, '问题至少 5 个字').max(200, '问题最多 200 个字'),
    description: z.string().trim().max(5000, '规则说明最多 5000 字').default(''),
    category: z.string().trim().min(1, '请选择分类').max(20),
    closeAt: z.number().int('截止时间无效'),
    settleAt: z.number().int('结算时间无效').optional(),
    mode: z.enum(['pool', 'polymarket']).default('pool'),
    outcomes: z
      .array(outcomeLabel)
      .min(MIN_OUTCOMES, `至少 ${MIN_OUTCOMES} 个选项`)
      .max(MAX_OUTCOMES, `最多 ${MAX_OUTCOMES} 个选项`),
  })
  .refine((v) => v.settleAt === undefined || v.settleAt >= v.closeAt, {
    message: '结算时间不能早于停止交易时间',
    path: ['settleAt'],
  })
  .refine(
    (v) =>
      v.mode !== 'polymarket' ||
      v.outcomes.length >= MIN_MULTI_OUTCOMES ||
      (v.outcomes.length === 2 && v.outcomes[0] === 'Yes' && v.outcomes[1] === 'No'),
    {
      message: `Polymarket 是非题用 Yes / No 两个选项，多选题至少 ${MIN_MULTI_OUTCOMES} 个选项`,
      path: ['outcomes'],
    },
  )
  .refine((v) => new Set(v.outcomes.map((o) => o.toLowerCase())).size === v.outcomes.length, {
    message: '选项不能重复',
    path: ['outcomes'],
  });
export type CreateMarketInput = z.input<typeof createMarketSchema>;

export const betSchema = z.object({
  outcomeId: z.number().int(),
  amount: z.number().min(MIN_BET, `最少下注 ${MIN_BET}`).max(MAX_BET, '金额过大'),
});
export type BetInput = z.infer<typeof betSchema>;

// Whole shares and integer-cent prices keep every fill and collateral movement exact.
const shares = z.number().int().min(1).max(1_000_000);
const wholeCents = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-8;
const price = z.number().min(0.01).max(0.99).refine(wholeCents, '价格精确到 0.01');
const outcomeId = z.number().int().positive();

/** Split or merge complete sets; multi-outcome markets name the option whose Yes/No pair it is. */
export const shareAmountSchema = z.object({ quantity: shares, outcomeId: outcomeId.optional() });

/** Turn No shares of some options into Yes shares of every other option (multi-outcome markets). */
export const convertSchema = z.object({
  quantity: shares,
  outcomeIds: z.array(outcomeId).min(1, '至少选一个选项').max(MAX_OUTCOMES),
});

const orderObject = z.object({
  outcomeId,
  /** Which share of the option: yes (default) or no. Binary markets may also name the No outcome. */
  token: z.enum(TOKENS).optional(),
  side: z.enum(['buy', 'sell']),
  /** GTC (default) and GTD rest on the book; FOK and FAK execute at once (market orders). */
  type: z.enum(ORDER_TYPES).optional(),
  /** Limit price; for FOK/FAK the worst acceptable price (defaults to 0.99 for buys, 0.01 for sells). */
  price: price.optional(),
  /** Shares to trade. */
  quantity: shares.optional(),
  /** Instead of shares: spend up to this much on a FOK/FAK buy, in whole shares. */
  amount: z.number().min(0.01).max(MAX_BET).refine(wholeCents, '金额精确到 0.01').optional(),
  /** GTD only: when the unfilled rest is cancelled (ms). */
  expiresAt: z.number().int().positive().optional(),
  postOnly: z.boolean().optional(),
  clientOrderId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
});

function orderRules(v: z.infer<typeof orderObject>, ctx: z.RefinementCtx) {
  const type = v.type ?? 'GTC';
  const immediate = type === 'FOK' || type === 'FAK';
  const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
  if ((v.quantity === undefined) === (v.amount === undefined)) issue('份数和金额要填且只填一个', 'quantity');
  if (v.amount !== undefined && !(immediate && v.side === 'buy')) issue('按金额下单只能用于市价买入', 'amount');
  if (!immediate && v.price === undefined) issue('限价单需要填写价格', 'price');
  if ((type === 'GTD') !== (v.expiresAt !== undefined)) issue('只有 GTD 订单需要（也必须）设置到期时间', 'expiresAt');
  if (v.postOnly && immediate) issue('Post-only 只能用于挂单（GTC / GTD）', 'postOnly');
}

export const orderSchema = orderObject.superRefine(orderRules);
export const tradingOrderSchema = orderObject.extend({ marketId: z.number().int().positive() }).superRefine(orderRules);
export type OrderInput = z.infer<typeof orderSchema>;

/** Trade a Polymarket mirror at Polymarket's live prices: buy by amount or shares, sell shares. */
export const mimicOrderSchema = z
  .object({
    outcomeId,
    token: z.enum(TOKENS).optional(),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['FOK', 'FAK']).optional(),
    price: price.optional(),
    quantity: shares.optional(),
    amount: z.number().min(0.01).max(MAX_BET).refine(wholeCents, '金额精确到 0.01').optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.quantity === undefined) === (v.amount === undefined))
      ctx.addIssue({ code: 'custom', message: '份数和金额要填且只填一个', path: ['quantity'] });
    if (v.amount !== undefined && v.side !== 'buy')
      ctx.addIssue({ code: 'custom', message: '按金额下单只能用于买入', path: ['amount'] });
  });
export type MimicOrderInput = z.infer<typeof mimicOrderSchema>;

export const resolveMarketSchema = z.object({
  outcomeId: z.number().int(),
  note: z.string().trim().max(1000).optional(),
});

export const cancelMarketSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, '评论不能为空').max(1000, '评论最多 1000 字'),
});

const adminReason = z.string().trim().min(2, '请写明原因').max(200, '原因最多 200 字');

export const adminFeatureSchema = z.object({
  key: z.enum(['polymarket', 'mimic']),
  enabled: z.boolean(),
});

export const adminBalanceSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
  /** Positive to add, negative to take away. */
  amount: z
    .number()
    .refine((n) => Math.abs(n) >= 0.01, '金额至少 0.01')
    .refine((n) => Math.abs(n) <= MAX_BET, '金额过大'),
  reason: adminReason,
});

export const adminGrantAllSchema = z.object({
  amount: z.number().min(0.01, '金额至少 0.01').max(MAX_BET, '金额过大'),
  reason: adminReason,
});

export const adminUserSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名'),
});

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const adminSiteConfigSchema = z.object({
  // Written into .env as is, so no spaces, quotes or comment marks.
  inviteCode: z
    .string()
    .trim()
    .max(64, '邀请码最多 64 个字符')
    .regex(/^[^\s"'#\\]*$/, '邀请码不能包含空格、引号、# 或反斜杠'),
  privateMode: z.boolean(),
  startingBalance: z.number().min(0).max(MAX_BET, '金额过大'),
  dailyBonus: z.number().min(0).max(MAX_BET, '金额过大'),
  timezone: z.string().trim().min(1, '请填写时区').refine(isTimeZone, '时区无效，例如 Asia/Shanghai'),
});

/** How many of Polymarket's busiest events the mirror copies. */
export const adminMimicSchema = z.object({ topK: z.number().int().min(1, '至少 1 个').max(100, '最多 100 个') });
