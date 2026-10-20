import { spawn } from 'node:child_process';
import type { FeatureState } from '@watercooler/shared';
import { ensureBots } from './bots/agent';
import { loadBotConfig, type BotConfig } from './bots/config';
import { createAsk, createChat } from './bots/llm';
import { startBots } from './bots/scheduler';
import type { Config } from './config';
import type { DB } from './db';
import { getFeatureFlags } from './services/admin';
import { startWecom, type WecomService } from './wecom/bot';
import { connectWecom } from './wecom/transport';

/** The background services as the HTTP app sees them. */
export interface AppRuntime {
  botsRunning(): boolean;
  wecom(): Pick<WecomService, 'announceBinding'> | undefined;
  features(): FeatureState[];
  /** Start or stop the services to match the feature flags and the current bot.json. */
  apply(): Promise<void>;
}

export interface Runtime extends AppRuntime {
  stop(): void;
}

export interface RuntimeDeps {
  db: DB;
  config: Config;
  now: () => number;
  log?: (m: string) => void;
  /** Overridable in tests; both default to the real bots and WeCom connection. */
  startBots?: (bot: BotConfig) => Promise<() => void>;
  startWecom?: (bot: BotConfig) => WecomService;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs the AI bots and the WeCom bot when their feature flag is on and bot.json has what they
 * need. bot.json is re-read on every apply(), so credentials can change without a restart; a
 * service whose settings changed is restarted.
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
      return startWecom({ db, config, settings: bot.wecom!, chat: createChat(bot), transport, now, log: wecomLog });
    });

  let bot: BotConfig | null = null;
  let botError: string | null = null;
  let bots: { stop: () => void; key: string } | null = null;
  let botsProblem: string | null = null;
  let wecom: { service: WecomService; key: string } | null = null;
  let wecomProblem: string | null = null;

  async function sync(): Promise<void> {
    try {
      bot = loadBotConfig(config.botConfigPath);
      botError = null;
    } catch (err) {
      bot = null;
      botError = errorText(err);
    }
    const flags = getFeatureFlags(db);

    const botsKey = bot ? JSON.stringify({ ...bot, wecom: undefined }) : null;
    if (bots && (!flags.aiBots || bots.key !== botsKey)) {
      bots.stop();
      bots = null;
      log('🤖 AI bots stopped');
    }
    botsProblem = null;
    if (flags.aiBots && bot && !bots) {
      try {
        bots = { stop: await launchBots(bot), key: botsKey! };
      } catch (err) {
        botsProblem = `启动失败：${errorText(err)}`;
        log(`AI bots failed to start: ${errorText(err)}`);
      }
    }

    const wecomKey = bot?.wecom
      ? JSON.stringify([bot.wecom, bot.endpoint, bot.apiKey, bot.model, bot.effort, bot.refusalFallback])
      : null;
    if (wecom && (!flags.wecom || wecom.key !== wecomKey)) {
      wecom.service.stop();
      wecom = null;
      log('[wecom] stopped');
    }
    wecomProblem = null;
    if (flags.wecom && bot?.wecom && !wecom) {
      try {
        wecom = { service: launchWecom(bot), key: wecomKey! };
      } catch (err) {
        wecomProblem = `启动失败：${errorText(err)}`;
        log(`WeCom bot failed to start: ${errorText(err)}`);
      }
    }
  }

  // One sync at a time: two quick toggles must not start a service twice.
  let queue: Promise<void> = Promise.resolve();

  return {
    botsRunning: () => bots !== null,
    wecom: () => wecom?.service,
    apply() {
      queue = queue.then(sync, sync);
      return queue;
    },
    features() {
      const flags = getFeatureFlags(db);
      const noConfig = botError ?? '服务器上没有 bot.json';
      return [
        {
          key: 'aiBots',
          enabled: flags.aiBots,
          configured: bot !== null,
          active: bots !== null,
          problem: flags.aiBots && !bots ? (bot ? (botsProblem ?? '正在启动') : noConfig) : null,
        },
        {
          key: 'wecom',
          enabled: flags.wecom,
          configured: Boolean(bot?.wecom),
          active: wecom !== null && wecom.service.connected(),
          problem: !flags.wecom
            ? null
            : wecom
              ? wecom.service.connected()
                ? null
                : '正在连接企业微信；一直连不上请检查 botId / secret'
              : bot?.wecom
                ? (wecomProblem ?? '正在启动')
                : bot
                  ? 'bot.json 里没有 wecom 配置'
                  : noConfig,
        },
        { key: 'polymarket', enabled: flags.polymarket, configured: null, active: flags.polymarket, problem: null },
      ];
    },
    stop() {
      bots?.stop();
      wecom?.service.stop();
      bots = null;
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
