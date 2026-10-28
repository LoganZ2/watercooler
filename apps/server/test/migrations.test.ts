import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { migrations } from '../src/db/migrations';
import { listMarkets } from '../src/services/markets';

describe('upstream and Polymarket database upgrades', () => {
  const cases = [
    ...[2, 3, 4].map((version) => ({ lineage: 'upstream', version, sql: migrations.slice(0, version) })),
    { lineage: 'polymarket', version: 7, sql: migrations.slice(0, 7) },
    ...[3, 4, 5, 6].map((version) => ({
      lineage: 'fork',
      version,
      sql: [...migrations.slice(0, 2), ...migrations.slice(4, version + 2)],
    })),
  ];
  it.each(cases)('preserves assets from $lineage version $version and can reopen', ({ lineage, version, sql }) => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    const path = join(dir, 'db.sqlite');
    let db = new Database(path);
    try {
      // Fixture setup need not fsync every statement; upgrades still use the real opener.
      db.pragma('journal_mode = MEMORY');
      db.pragma('synchronous = OFF');
      for (const migration of sql) db.exec(migration);
      db.pragma(`user_version = ${version}`);
      db.exec(`
        INSERT INTO users(id,username,display_name,password_hash,balance,created_at) VALUES (1,'old','old','hash',90000,0);
        INSERT INTO markets(id,question,category,creator_id,close_at,pot,created_at) VALUES (1,'old market','生活',1,100,10000,0);
        INSERT INTO outcomes(id,market_id,idx,label,pool) VALUES (1,1,0,'是',10000),(2,1,1,'否',0);
        INSERT INTO bets(user_id,market_id,outcome_id,amount,created_at) VALUES (1,1,1,10000,0);
        INSERT INTO ledger(user_id,kind,amount,balance_after,market_id,created_at) VALUES (1,'bet',-10000,90000,1,0);
      `);
      if (lineage === 'fork') {
        db.exec(`
          INSERT INTO markets(id,question,category,creator_id,close_at,pot,created_at,mode) VALUES (2,'exchange','生活',1,200,1000,0,'polymarket');
          INSERT INTO outcomes(id,market_id,idx,label) VALUES (3,2,0,'Yes'),(4,2,1,'No');
          INSERT INTO exchange_positions(user_id,market_id,outcome_id,quantity,reserved) VALUES (1,2,3,10,2),(1,2,4,10,0);
          INSERT INTO exchange_orders(user_id,market_id,outcome_id,side,price,quantity,remaining,created_at) VALUES (1,2,3,'sell',60,2,2,0);
        `);
        if (version === 6) db.exec('UPDATE markets SET settle_at = close_at + 50');
      }
      db.close();
      db = openDatabase(path);
      expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
      expect(db.prepare('SELECT balance,is_bot FROM users').get()).toEqual({ balance: 90000, is_bot: 0 });
      expect(db.prepare('SELECT mode,is_ai,pot,close_at,settle_at FROM markets WHERE id = 1').get()).toEqual({
        mode: 'pool',
        is_ai: 0,
        pot: 10000,
        close_at: 100,
        settle_at: lineage === 'fork' && version === 6 ? 150 : 100,
      });
      expect(db.prepare('SELECT kind,amount FROM ledger').get()).toEqual({ kind: 'bet', amount: -10000 });
      expect(db.prepare('SELECT amount FROM bets').get()).toEqual({ amount: 10000 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM wecom_bindings').get()).toEqual({ n: 0 });
      if (lineage === 'fork') {
        expect(db.prepare('SELECT quantity,reserved FROM exchange_positions WHERE outcome_id = 3').get()).toEqual({
          quantity: 10,
          reserved: 2,
        });
        expect(db.prepare('SELECT price,remaining,post_only,client_order_id FROM exchange_orders').get()).toEqual({
          price: 60,
          remaining: 2,
          post_only: 0,
          client_order_id: null,
        });
        expect(db.prepare('SELECT pot FROM markets WHERE id = 2').get()).toEqual({ pot: 1000 });
      }
      db.close();
      db = openDatabase(path);
      expect(db.prepare('SELECT balance FROM users').get()).toEqual({ balance: 90000 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('backfills Polymarket cost basis from past fills and splits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    const path = join(dir, 'db.sqlite');
    let db = new Database(path);
    try {
      for (const migration of migrations.slice(0, 9)) db.exec(migration);
      db.pragma('user_version = 9');
      db.exec(`
        INSERT INTO users(id,username,display_name,password_hash,balance,created_at)
          VALUES (1,'a','a','h',0,0),(2,'b','b','h',0,0),(3,'c','c','h',0,0);
        INSERT INTO markets(id,question,category,creator_id,close_at,pot,created_at,mode) VALUES (2,'x','生活',1,200,1200,0,'polymarket');
        INSERT INTO outcomes(id,market_id,idx,label) VALUES (3,2,0,'Yes'),(4,2,1,'No');
        INSERT INTO ledger(user_id,kind,amount,balance_after,market_id,created_at) VALUES (1,'split',-1000,0,2,0);
        INSERT INTO exchange_orders(id,user_id,market_id,outcome_id,side,price,quantity,remaining,status,created_at) VALUES
          (1,1,2,3,'sell',60,4,0,'filled',1),(2,2,2,3,'buy',60,4,0,'filled',1),
          (3,3,2,4,'buy',70,2,0,'filled',2),(4,2,2,3,'buy',30,2,0,'filled',2);
        INSERT INTO exchange_trades(market_id,outcome_id,maker_id,taker_id,price,quantity,kind,created_at) VALUES
          (2,3,1,2,60,4,'transfer',1),(2,3,3,4,30,2,'mint',2);
        INSERT INTO exchange_positions(user_id,market_id,outcome_id,quantity,reserved) VALUES
          (1,2,3,6,0),(1,2,4,10,0),(2,2,3,6,0),(3,2,4,2,0);
      `);
      db.close();
      db = openDatabase(path);
      expect(
        db
          .prepare('SELECT user_id,outcome_id,token,quantity,cost FROM exchange_positions ORDER BY user_id,outcome_id')
          .all(),
      ).toEqual([
        { user_id: 1, outcome_id: 3, token: 0, quantity: 6, cost: 300 },
        { user_id: 1, outcome_id: 4, token: 0, quantity: 10, cost: 500 },
        { user_id: 2, outcome_id: 3, token: 0, quantity: 6, cost: 300 },
        { user_id: 3, outcome_id: 4, token: 0, quantity: 2, cost: 140 },
      ]);
      expect(db.prepare('SELECT neg_risk FROM markets').get()).toEqual({ neg_risk: 0 });
      expect(db.prepare('SELECT token,order_type,expires_at,amount FROM exchange_orders WHERE id = 1').get()).toEqual({
        token: 0,
        order_type: 'GTC',
        expires_at: null,
        amount: null,
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the old AI werewolf markets out of the people's lists with the bots' markets", () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-migrate-'));
    const path = join(dir, 'db.sqlite');
    let db = new Database(path);
    try {
      for (const migration of migrations.slice(0, 12)) db.exec(migration);
      db.pragma('user_version = 12');
      db.exec(`
        INSERT INTO users(id,username,display_name,password_hash,balance,is_bot,created_at)
          VALUES (1,'werewolf','狼人杀法官','!',0,1,0),(2,'alice','alice','h',0,0,0);
        INSERT INTO werewolf_games(id,status,players,cutoff,seats,starts_at,created_at)
          VALUES (1,'running',9,5,'[]',0,0);
        INSERT INTO markets(id,question,category,creator_id,close_at,settle_at,created_at,werewolf_game_id)
          VALUES (1,'AI 狼人杀第 1 局：好人还是狼人获胜？','娱乐',1,9e12,9e12,0,1),
                 (2,'周五下雨吗？','生活',2,9e12,9e12,0,NULL);
      `);
      db.close();
      db = openDatabase(path);
      expect(db.prepare('SELECT id, is_ai FROM markets ORDER BY id').all()).toEqual([
        { id: 1, is_ai: 1 },
        { id: 2, is_ai: 0 },
      ]);
      expect(listMarkets(db, 0, { zone: 'human' }).map((m) => m.id)).toEqual([2]);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
