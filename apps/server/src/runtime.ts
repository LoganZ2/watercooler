import { spawn } from 'node:child_process';
import type { FeatureState } from '@watercooler/shared';
import { ensureBots } from './bots/agent';
import { loadBotConfig, type BotConfig } from './bots/config';
import { createAsk, createChat, createPlay } from './bots/llm';
import { startBots } from './bots/scheduler';
import type { Config } from './config';
import type { DB } from './db';
import { createPolymarketClient, type PolymarketClient } from './mimic/client';
import { startMimic, type MimicService } from './mimic/sync';
import { featureOn, getFeatureFlags, seedFeatureFlags } from './services/admin';
import { startWerewolf, type WerewolfService } from './werewolf/service';
import { startWecom, type WecomService } from './wecom/bot';
import { connectWecom } from './wecom/transport';

/** The background services as the HTTP app sees them. */
export interface AppRuntime {
  botsRunning(): boolean;
  wecom(): Pick<WecomService, 'announceBinding'> | undefined;
  features(): FeatureState[];
  /** Start or stop the services to match the feature flags. */
  apply(): Promise<void>;
  /** Run a Polymarket mirror pass now instead of at the next interval. */
  syncMimic?(): Promise<void>;
}

export interface Runtime extends AppRuntime {
  stop(): void;
}

export interface RuntimeDeps {
  db: DB;
  config: Config;
  now: () => number;
  log?: (m: string) => void;
  /** Overridable in tests; they default to the real bots, WeCom connection and werewolf games. */
  startBots?: (bot: BotConfig) => Promise<() => void>;
  startWecom?: (bot: BotConfig) => WecomService;
  startWerewolf?: (bot: BotConfig) => WerewolfService;
  /** Polymarket's public APIs, for the mirror; tests pass a fake. */
  polymarket?: PolymarketClient;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs the AI bots and the WeCom bot exactly when their feature flag is on. bot.json only supplies
 * their credentials, read once at startup: a flag that is on while they are missing is reported
 * as misconfigured, never treated as off.
 */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const { db, config, now } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));

  const launchBots =
    deps.startBots ??
    (async (bot: BotConfig) => {
      const botDeps = { db, config, bot, ask: createAsk(bot), now };
      const ids = await ensureBots(botDeps);
      const stop = startBots(botDeps, ids);
      log(`🤖 ${ids.length} AI bots running on ${bot.model}`);
      return stop;
    });
  const launchWecom =
    deps.startWecom ??
    ((bot: BotConfig) => {
      const wecomLog = (m: string) => log(`[wecom] ${m}`);
      const transport = connectWecom(bot.wecom!, wecomLog);
      return startWecom({
        db,
        config,
        settings: bot.wecom!,
        chat: createChat(bot),
        transport,
        now,
        log: wecomLog,
        polymarket: deps.polymarket,
      });
    });

  const launchWerewolf =
    deps.startWerewolf ??
    ((bot: BotConfig) => {
      log(`🐺 werewolf games running on ${bot.werewolf.model ?? bot.model}, ${bot.werewolf.players} players`);
      return startWerewolf({
        db,
        play: createPlay(bot),
        now,
        log,
        players: bot.werewolf.players,
        restMs: bot.werewolf.restMinutes * 60_000,
      });
    });

  // bot.json is read once, at the first apply(): changed credentials take effect after a restart,
  // like every other setting, while flags switch the services on and off right away.
  let loaded = false;
  let bot: BotConfig | null = null;
  let botError: string | null = null;
  let stopBots: (() => void) | null = null;
  let botsProblem: string | null = null;
  let wecom: WecomService | null = null;
  let wecomProblem: string | null = null;
  // The mirror always runs: with the flag off it still settles positions people hold.
  let mimic: MimicService | null = null;
  let mimicWasOn = false;
  let werewolf: WerewolfService | null = null;

  async function sync(): Promise<void> {
    if (!loaded) {
      loaded = true;
      try {
        bot = loadBotConfig(config.botConfigPath);
        // Instances that ran before the flags existed keep running what their bot.json enabled.
        const seeded = seedFeatureFlags(db, { aiBots: bot !== null, wecom: Boolean(bot?.wecom) }, now());
        if (seeded.length) log(`feature flags switched on from bot.json: ${seeded.join(', ')}`);
      } catch (err) {
        botError = errorText(err);
      }
    }
    const flags = getFeatureFlags(db);

    if (stopBots && !flags.aiBots) {
      stopBots();
      stopBots = null;
      log('🤖 AI bots stopped');
    }
    botsProblem = null;
    if (flags.aiBots && bot && !stopBots) {
      try {
        stopBots = await launchBots(bot);
      } catch (err) {
        botsProblem = `启动失败：${errorText(err)}`;
        log(`AI bots failed to start: ${errorText(err)}`);
      }
    }

    mimic ??= startMimic({
      db,
      client: deps.polymarket ?? createPolymarketClient(config),
      now,
      enabled: () => featureOn(getFeatureFlags(db), 'mimic'),
      log,
    });
    const mimicOn = featureOn(flags, 'mimic');
    if (mimicOn && !mimicWasOn) void mimic.syncNow();
    mimicWasOn = mimicOn;

    if (werewolf && !flags.werewolf) {
      werewolf.stop();
      werewolf = null;
      log('🐺 werewolf games paused');
    }
    if (flags.werewolf && bot && !werewolf) werewolf = launchWerewolf(bot);

    if (wecom && !flags.wecom) {
      wecom.stop();
      wecom = null;
      log('[wecom] stopped');
    }
    wecomProblem = null;
    if (flags.wecom && bot?.wecom && !wecom) {
      try {
        wecom = launchWecom(bot);
      } catch (err) {
        wecomProblem = `启动失败：${errorText(err)}`;
        log(`WeCom bot failed to start: ${errorText(err)}`);
      }
    }
  }

  const clock = (t: number) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(t);

  // One sync at a time: two quick toggles must not start a service twice.
  let queue: Promise<void> = Promise.resolve();

  return {
    botsRunning: () => stopBots !== null,
    wecom: () => wecom ?? undefined,
    apply() {
      queue = queue.then(sync, sync);
      return queue;
    },
    syncMimic: () => mimic?.syncNow() ?? Promise.resolve(),
    features() {
      const flags = getFeatureFlags(db);
      const noConfig = botError ? `缺少配置：bot.json 有误（${botError}）` : '缺少配置：服务器上没有 bot.json';
      return [
        {
          key: 'aiBots',
          enabled: flags.aiBots,
          configured: bot !== null,
          active: stopBots !== null,
          problem: flags.aiBots && !stopBots ? (bot ? (botsProblem ?? '正在启动') : noConfig) : null,
        },
        {
          key: 'wecom',
          enabled: flags.wecom,
          configured: Boolean(bot?.wecom),
          active: wecom !== null && wecom.connected(),
          problem: !flags.wecom
            ? null
            : wecom
              ? wecom.connected()
                ? null
                : '正在连接企业微信；一直连不上请检查 botId / secret'
              : bot?.wecom
                ? (wecomProblem ?? '正在启动')
                : bot
                  ? '缺少配置：bot.json 里没有 wecom 配置'
                  : noConfig,
        },
        { key: 'polymarket', enabled: flags.polymarket, configured: null, active: flags.polymarket, problem: null },
        (() => {
          const on = featureOn(flags, 'mimic');
          const s = mimic?.status();
          return {
            key: 'mimic' as const,
            enabled: on,
            configured: null,
            requires: 'polymarket' as const,
            active: on && Boolean(s?.lastSync) && !s?.error,
            problem: on && s?.error ? `同步失败：${s.error}` : null,
            status: !on
              ? null
              : s?.lastSync
                ? `${clock(s.lastSync)} 同步过，正在镜像 ${s.listed} 个盘`
                : '等待第一次同步',
          };
        })(),
        (() => {
          const s = werewolf?.status();
          const g = s?.game;
          return {
            key: 'werewolf' as const,
            enabled: flags.werewolf,
            configured: bot !== null,
            active: werewolf !== null && !s?.problem,
            problem: !flags.werewolf ? null : !bot ? noConfig : (s?.problem ?? null),
            status: !g
              ? null
              : g.status === 'waiting'
                ? `第 ${g.id} 局 ${clock(g.startsAt)} 开局，正在接受下注`
                : `第 ${g.id} 局：${g.phase}，剩 ${g.alive}/${g.players} 人${g.bettingOpen ? '' : '，已停止下注'}`,
          };
        })(),
      ];
    },
    stop() {
      stopBots?.();
      wecom?.stop();
      mimic?.stop();
      werewolf?.stop();
      werewolf = null;
      mimic = null;
      stopBots = null;
      wecom = null;
    },
  };
}

/**
 * Restart through the instance's control script (deploy/watercooler.sh exports CONTROL_SCRIPT):
 * it stops this process and starts a fresh one, so it must outlive us. Undefined when the app is
 * not run by that script, e.g. in development.
 */
export function controlScriptRestart(script = process.env.CONTROL_SCRIPT): (() => void) | undefined {
  if (!script) return undefined;
  return () => {
    spawn('bash', [script, 'restart'], { detached: true, stdio: 'ignore' }).unref();
  };
}
