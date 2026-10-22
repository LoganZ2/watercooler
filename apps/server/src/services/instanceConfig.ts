import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AdminInstanceConfig, AdminSiteConfig } from '@watercooler/shared';
import type { z } from 'zod';
import type {
  adminAiConfigSchema,
  adminSiteConfigSchema,
  adminWecomConfigSchema,
  adminWerewolfConfigSchema,
} from '@watercooler/shared';
import { botConfigSchema } from '../bots/config';
import type { Config } from '../config';
import { badRequest, conflict } from '../lib/http';

/**
 * The configuration admins edit at /admin lives in the same files the server reads at startup:
 * bot.json (model and WeCom credentials) and .env (site settings). Saving never applies anything
 * to the running process; the instance picks it up on its next start.
 */

/** Site settings and the .env keys they are stored under. */
const ENV_KEYS: Record<keyof AdminSiteConfig, string> = {
  inviteCode: 'INVITE_CODE',
  privateMode: 'PRIVATE_MODE',
  startingBalance: 'STARTING_BALANCE',
  dailyBonus: 'DAILY_BONUS',
  timezone: 'APP_TIMEZONE',
};

export const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** Where writing `path` should land: through symlinks (<release>/.env -> shared/.env), even dangling ones. */
function resolveTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return resolve(dirname(path), readlinkSync(path));
    } catch {
      return path;
    }
  }
}

/** Write next to the target and rename over it, so a crash never leaves half a file. */
function writeAtomic(path: string, content: string): void {
  const target = resolveTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

type BotObject = Record<string, unknown> & { wecom?: Record<string, unknown>; werewolf?: Record<string, unknown> };

function readBotObject(path: string): BotObject | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as BotObject;
  } catch {
    // reported below
  }
  throw conflict('服务器上的 bot.json 不是合法的 JSON，先在服务器上修好或删掉它');
}

function validateBot(next: BotObject): void {
  const parsed = botConfigSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`配置不合法：${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim());
  }
}

const writeBot = (path: string, next: BotObject) => writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);

/** "已设置（…abcd）" for a saved secret, never the secret itself. */
const secretHint = (value: unknown) => (typeof value === 'string' && value ? `已设置（…${value.slice(-4)}）` : '');

function parseEnv(text: string | null): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (text ?? '').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return values;
}

export function describeInstanceConfig(config: Config, restartNeeded: boolean): AdminInstanceConfig {
  let raw: BotObject | null = null;
  let botError: string | null = null;
  try {
    raw = readBotObject(config.botConfigPath);
  } catch (err) {
    botError = (err as Error).message;
  }
  // Show defaults the way the server would fill them in; fall back to what is written.
  const parsed = raw ? botConfigSchema.safeParse(raw) : null;
  if (parsed && !parsed.success) {
    const issue = parsed.error.issues[0];
    botError = `${issue?.path.join('.') || '(root)'} ${issue?.message ?? '不合法'}`;
  }
  const bot = parsed?.success ? parsed.data : null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
  const wecom = raw?.wecom;
  const werewolf = raw?.werewolf;

  const env = parseEnv(readText(config.envFilePath));
  const envNum = (key: string, current: number) => {
    const n = Number(env.get(key));
    return env.has(key) && Number.isFinite(n) ? n : current;
  };

  return {
    ai: raw
      ? {
          endpoint: bot?.endpoint ?? str(raw.endpoint),
          model: bot?.model ?? str(raw.model),
          apiKeyHint: secretHint(raw.apiKey),
          bots: bot?.bots ?? num(raw.bots, 50),
          marketsPerDay: bot?.marketsPerDay ?? num(raw.marketsPerDay, 2),
          betsPerDay: bot?.betsPerDay ?? num(raw.betsPerDay, 50),
          flipProbability: bot?.flipProbability ?? num(raw.flipProbability, 0.2),
        }
      : null,
    wecom: wecom
      ? {
          botId: str(wecom.botId),
          secretHint: secretHint(wecom.secret),
          siteUrl: str(wecom.siteUrl),
          siteName: bot?.wecom?.siteName ?? (str(wecom.siteName) || 'Watercooler'),
          messagesPerHour: bot?.wecom?.messagesPerHour ?? num(wecom.messagesPerHour, 30),
        }
      : null,
    werewolf: raw
      ? {
          players: bot?.werewolf.players ?? num(werewolf?.players, 9),
          restMinutes: bot?.werewolf.restMinutes ?? num(werewolf?.restMinutes, 10),
          model: bot?.werewolf.model ?? str(werewolf?.model),
        }
      : null,
    // What .env says (applied at the next start), or what is running when .env does not say.
    site: {
      inviteCode: env.has(ENV_KEYS.inviteCode) ? env.get(ENV_KEYS.inviteCode)! : (config.inviteCode ?? ''),
      privateMode: env.has(ENV_KEYS.privateMode)
        ? ['1', 'true', 'yes', 'on'].includes(env.get(ENV_KEYS.privateMode)!.toLowerCase())
        : config.privateMode,
      startingBalance: envNum(ENV_KEYS.startingBalance, config.startingBalance),
      dailyBonus: envNum(ENV_KEYS.dailyBonus, config.dailyBonus),
      timezone: env.get(ENV_KEYS.timezone) || config.timezone,
    },
    botError,
    restartNeeded,
  };
}

/** Save the model settings, keeping the WeCom section and anything else already in bot.json. */
export function saveAiConfig(path: string, input: z.output<typeof adminAiConfigSchema>): boolean {
  const current = readBotObject(path) ?? {};
  const apiKey = input.apiKey || current.apiKey;
  if (!apiKey) throw badRequest('请填写 API key');
  const next: BotObject = {
    ...current,
    endpoint: input.endpoint,
    apiKey,
    model: input.model,
    bots: input.bots,
    marketsPerDay: input.marketsPerDay,
    betsPerDay: input.betsPerDay,
    flipProbability: input.flipProbability,
  };
  validateBot(next);
  writeBot(path, next);
  return Boolean(input.apiKey);
}

export function saveWecomConfig(path: string, input: z.output<typeof adminWecomConfigSchema>): boolean {
  const current = readBotObject(path);
  if (!current) throw conflict('先保存 AI 模型配置：企业微信聊天用的是同一个模型');
  const previous = current.wecom ?? {};
  const secret = input.secret || previous.secret;
  if (!secret) throw badRequest('请填写 Secret');
  const next: BotObject = {
    ...current,
    wecom: {
      ...previous,
      botId: input.botId,
      secret,
      siteUrl: input.siteUrl,
      siteName: input.siteName,
      messagesPerHour: input.messagesPerHour,
    },
  };
  validateBot(next);
  writeBot(path, next);
  return Boolean(input.secret);
}

/** Save the werewolf settings; an empty model means the AI model's. */
export function saveWerewolfConfig(path: string, input: z.output<typeof adminWerewolfConfigSchema>): void {
  const current = readBotObject(path);
  if (!current) throw conflict('先保存 AI 模型配置：狼人杀的玩家用它的 API key');
  const next: BotObject = {
    ...current,
    werewolf: {
      players: input.players,
      restMinutes: input.restMinutes,
      ...(input.model ? { model: input.model } : {}),
    },
  };
  validateBot(next);
  writeBot(path, next);
}

export function removeWecomConfig(path: string): void {
  const current = readBotObject(path);
  if (!current?.wecom) return;
  const { wecom: _removed, ...rest } = current;
  writeBot(path, rest);
}

/** Set the site settings in .env, leaving every other line (comments, other keys) as it was. */
export function saveSiteConfig(path: string, input: z.output<typeof adminSiteConfigSchema>): void {
  const values: Record<string, string | null> = {
    [ENV_KEYS.inviteCode]: input.inviteCode || null,
    [ENV_KEYS.privateMode]: input.privateMode ? 'true' : 'false',
    [ENV_KEYS.startingBalance]: String(input.startingBalance),
    [ENV_KEYS.dailyBonus]: String(input.dailyBonus),
    [ENV_KEYS.timezone]: input.timezone,
  };
  const lines = (readText(path) ?? '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  const written = new Set<string>();
  for (const line of lines) {
    const key = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (key && key in values) {
      if (values[key] !== null && !written.has(key)) out.push(`${key}=${values[key]}`);
      written.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key) && value !== null) out.push(`${key}=${value}`);
  }
  writeAtomic(path, `${out.join('\n')}\n`);
}
