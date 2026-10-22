import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig, loadDotEnv } from './config';
import { openDatabase } from './db';
import { createPolymarketClient } from './mimic/client';
import { controlScriptRestart, createRuntime } from './runtime';
import { serveSpa } from './static';

loadDotEnv();
const config = loadConfig();
const db = openDatabase(config.databasePath);

// AI bots, the WeCom bot and the Polymarket mirror follow the admin's feature flags (see runtime.ts).
const polymarket = createPolymarketClient(config);
const runtime = createRuntime({ db, config, now: Date.now, polymarket });
const app = createApp({ db, config, now: Date.now, runtime, restart: controlScriptRestart(), polymarket });
if (config.staticDir) serveSpa(app, config.staticDir);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`💧 Watercooler API listening on http://localhost:${info.port}`);
  console.log(`   database: ${config.databasePath}`);
  console.log(config.staticDir ? `   serving web app from ${config.staticDir}` : '   web app not built — API only');
  if (config.inviteCode) console.log('   registration requires an invite code');
});

await runtime.apply();
for (const f of runtime.features()) {
  // A feature switched on without its credentials is a misconfiguration worth seeing in the log.
  if (f.enabled && f.problem) console.warn(`   ${f.key} is on but not running: ${f.problem}`);
}

function shutdown() {
  runtime.stop();
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
