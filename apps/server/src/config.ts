import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/server, both when running from src/ (tsx) and from dist/ (built). */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '../..');

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  /** When set, registering requires this invite code. */
  inviteCode: string | null;
  /** Currency granted to every new account. */
  startingBalance: number;
  /** Currency a user can claim once per day. 0 disables it. */
  dailyBonus: number;
  /** Require login to see anything at all (otherwise browsing is public, like Polymarket). */
  privateMode: boolean;
  /** Timezone used to decide what "today" means for the daily bonus. */
  timezone: string;
  /** Built web app to serve, or null to run API-only. */
  staticDir: string | null;
  /**
   * Public URL prefix when served under a sub-path behind a reverse proxy (e.g. "/watercooler"),
   * or "" at the site root. The proxy strips it before forwarding; we only need it to scope cookies.
   */
  basePath: string;
  /** bot.json with the AI bots' model settings; bots stay off when the file is missing. */
  botConfigPath: string;
  /** The .env file loaded at startup; admins edit its site settings at /admin. */
  envFilePath: string;
  /** Instance name and deployed release, set by the control script on the server. */
  instance: string;
  release: string | null;
}

/** Load `.env` from the repo root or the current directory if present. */
export function loadDotEnv(): void {
  for (const file of [resolve(REPO_ROOT, '.env'), resolve(process.cwd(), '.env')]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in environment: ${value}`);
  return n;
}

/** "/watercooler/", "watercooler" -> "/watercooler"; "/" or empty -> "". */
export function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultStatic = resolve(REPO_ROOT, 'apps/web/dist');
  const staticDir = env.STATIC_DIR ? resolve(env.STATIC_DIR) : existsSync(defaultStatic) ? defaultStatic : null;
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    databasePath: env.DATABASE_PATH ? resolve(env.DATABASE_PATH) : resolve(REPO_ROOT, 'data/watercooler.db'),
    inviteCode: env.INVITE_CODE?.trim() || null,
    startingBalance: num(env.STARTING_BALANCE, 1000),
    dailyBonus: num(env.DAILY_BONUS, 100),
    privateMode: bool(env.PRIVATE_MODE, false),
    timezone: env.APP_TIMEZONE || 'Asia/Shanghai',
    staticDir,
    basePath: normalizeBasePath(env.BASE_PATH),
    botConfigPath: env.BOT_CONFIG ? resolve(env.BOT_CONFIG) : resolve(REPO_ROOT, 'bot.json'),
    // On the server <release>/.env links to shared/.env (deploy/remote-deploy.sh).
    envFilePath: resolve(REPO_ROOT, '.env'),
    instance: env.INSTANCE?.trim() || 'local',
    release: env.RELEASE?.trim() || null,
  };
}
