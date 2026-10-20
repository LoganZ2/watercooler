import { z } from 'zod';
import { MAX_BET, MAX_OUTCOMES, MIN_BET, MIN_OUTCOMES } from './constants';

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
    (v) => v.mode !== 'polymarket' || (v.outcomes.length === 2 && v.outcomes[0] === 'Yes' && v.outcomes[1] === 'No'),
    {
      message: 'Polymarket 模式必须使用 Yes / No 两个选项',
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
export const shareAmountSchema = z.object({ quantity: z.number().int().min(1).max(1_000_000) });
export const orderSchema = shareAmountSchema.extend({
  postOnly: z.boolean().optional(),
  clientOrderId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  outcomeId: z.number().int().positive(),
  side: z.enum(['buy', 'sell']),
  price: z
    .number()
    .min(0.01)
    .max(0.99)
    .refine((p) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-8, '价格精确到 0.01'),
});
export type OrderInput = z.infer<typeof orderSchema>;

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

export const wecomBindSchema = z.object({
  token: z.string().trim().min(1, '绑定链接无效').max(200, '绑定链接无效'),
});

const adminReason = z.string().trim().min(2, '请写明原因').max(200, '原因最多 200 字');

export const adminFeatureSchema = z.object({
  key: z.enum(['aiBots', 'wecom', 'polymarket']),
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
