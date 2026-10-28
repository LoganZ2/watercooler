import { spawn } from 'node:child_process';
import type { FeatureState } from '@watercooler/shared';
import type { Config } from './config';
import type { DB } from './db';
import { createPolymarketClient, type PolymarketClient } from './mimic/client';
import { startMimic, type MimicService } from './mimic/sync';
import { featureOn, getFeatureFlags } from './services/admin';

/** The background services as the HTTP app sees them. */
export interface AppRuntime {
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
  /** Polymarket's public APIs, for the mirror; tests pass a fake. */
  polymarket?: PolymarketClient;
}

/** Runs the Polymarket mirror and reports the feature flags for /admin. */
export function createRuntime(deps: RuntimeDeps): Runtime {
  const { db, config, now } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));

  // The mirror always runs: with the flag off it still settles positions people hold.
  let mimic: MimicService | null = null;
  let mimicWasOn = false;

  async function sync(): Promise<void> {
    mimic ??= startMimic({
      db,
      client: deps.polymarket ?? createPolymarketClient(config),
      now,
      enabled: () => featureOn(getFeatureFlags(db), 'mimic'),
      log,
    });
    const mimicOn = featureOn(getFeatureFlags(db), 'mimic');
    if (mimicOn && !mimicWasOn) void mimic.syncNow();
    mimicWasOn = mimicOn;
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
    apply() {
      queue = queue.then(sync, sync);
      return queue;
    },
    syncMimic: () => mimic?.syncNow() ?? Promise.resolve(),
    features() {
      const flags = getFeatureFlags(db);
      const on = featureOn(flags, 'mimic');
      const s = mimic?.status();
      return [
        { key: 'polymarket', enabled: flags.polymarket, configured: null, active: flags.polymarket, problem: null },
        {
          key: 'mimic',
          enabled: on,
          configured: null,
          requires: 'polymarket',
          active: on && Boolean(s?.lastSync) && !s?.error,
          problem: on && s?.error ? `同步失败：${s.error}` : null,
          status: !on
            ? null
            : s?.lastSync
              ? `${clock(s.lastSync)} 同步过，正在镜像 ${s.listed} 个盘`
              : '等待第一次同步',
        },
      ];
    },
    stop() {
      mimic?.stop();
      mimic = null;
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
