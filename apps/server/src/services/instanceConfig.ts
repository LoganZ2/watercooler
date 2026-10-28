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
import type { AdminInstanceConfig, AdminSiteConfig, adminSiteConfigSchema } from '@watercooler/shared';
import type { z } from 'zod';
import type { Config } from '../config';

/**
 * The site settings admins edit at /admin live in the .env file the server reads at startup.
 * Saving never applies anything to the running process; the instance picks it up on its next start.
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

function parseEnv(text: string | null): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of (text ?? '').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  return values;
}

export function describeInstanceConfig(config: Config, restartNeeded: boolean): AdminInstanceConfig {
  const env = parseEnv(readText(config.envFilePath));
  const envNum = (key: string, current: number) => {
    const n = Number(env.get(key));
    return env.has(key) && Number.isFinite(n) ? n : current;
  };

  return {
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
    restartNeeded,
  };
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
