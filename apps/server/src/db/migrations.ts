/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 * Never edit a migration that has shipped — append a new one instead.
 *
 * Money columns (balance, amount, pool, pot) are INTEGER cents. Timestamps are unix milliseconds.
 */
export const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name    TEXT    NOT NULL,
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    balance         INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    last_bonus_date TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE markets (
    id                  INTEGER PRIMARY KEY,
    question            TEXT    NOT NULL,
    description         TEXT    NOT NULL DEFAULT '',
    category            TEXT    NOT NULL,
    creator_id          INTEGER NOT NULL REFERENCES users(id),
    liquidity           REAL    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
    close_at            INTEGER NOT NULL,
    resolved_outcome_id INTEGER,
    resolved_at         INTEGER,
    resolved_by         INTEGER REFERENCES users(id),
    resolution_note     TEXT,
    volume              INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL
  );
  CREATE INDEX markets_status ON markets(status, close_at);

  CREATE TABLE outcomes (
    id        INTEGER PRIMARY KEY,
    market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,
    label     TEXT    NOT NULL,
    shares    REAL    NOT NULL DEFAULT 0,
    UNIQUE (market_id, idx)
  );

  CREATE TABLE positions (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    shares     REAL    NOT NULL DEFAULT 0,
    cost       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, outcome_id)
  );
  CREATE INDEX positions_market ON positions(market_id);

  CREATE TABLE trades (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    market_id    INTEGER NOT NULL REFERENCES markets(id),
    outcome_id   INTEGER NOT NULL REFERENCES outcomes(id),
    side         TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
    shares       REAL    NOT NULL,
    amount       INTEGER NOT NULL,
    price_before REAL    NOT NULL,
    price_after  REAL    NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX trades_market ON trades(market_id, id);
  CREATE INDEX trades_user ON trades(user_id, id);
  CREATE INDEX trades_time ON trades(created_at);

  CREATE TABLE price_history (
    id         INTEGER PRIMARY KEY,
    market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    probs      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX price_history_market ON price_history(market_id, created_at);

  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_market ON comments(market_id, id);

  CREATE TABLE ledger (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    kind          TEXT    NOT NULL CHECK (kind IN ('signup', 'bonus', 'grant', 'buy', 'sell', 'payout', 'refund')),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    market_id     INTEGER REFERENCES markets(id),
    note          TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX ledger_user ON ledger(user_id, id);
  `,
  /* 2: pool (pari-mutuel) betting replaces the LMSR market maker; creators settle their own markets
        and there are no admins any more. Old market data is discarded; accounts are kept and every
        balance restarts at the default starting balance of 1000. */ `
  DROP TABLE comments;
  DROP TABLE price_history;
  DROP TABLE trades;
  DROP TABLE positions;
  DROP TABLE ledger;
  DROP TABLE outcomes;
  DROP TABLE markets;
  ALTER TABLE users DROP COLUMN role;

  CREATE TABLE markets (
    id                  INTEGER PRIMARY KEY,
    question            TEXT    NOT NULL,
    description         TEXT    NOT NULL DEFAULT '',
    category            TEXT    NOT NULL,
    creator_id          INTEGER NOT NULL REFERENCES users(id),
    status              TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
    close_at            INTEGER NOT NULL,
    resolved_outcome_id INTEGER,
    resolved_at         INTEGER,
    resolution_note     TEXT,
    pot                 INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL
  );
  CREATE INDEX markets_status ON markets(status, close_at);
  CREATE INDEX markets_creator ON markets(creator_id);

  CREATE TABLE outcomes (
    id        INTEGER PRIMARY KEY,
    market_id INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,
    label     TEXT    NOT NULL,
    pool      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (market_id, idx)
  );

  CREATE TABLE bets (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    amount     INTEGER NOT NULL CHECK (amount > 0),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX bets_market ON bets(market_id, id);
  CREATE INDEX bets_user ON bets(user_id, id);
  CREATE INDEX bets_time ON bets(created_at);

  CREATE TABLE price_history (
    id         INTEGER PRIMARY KEY,
    market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    probs      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX price_history_market ON price_history(market_id, created_at);

  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    market_id  INTEGER NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_market ON comments(market_id, id);

  CREATE TABLE ledger (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    kind          TEXT    NOT NULL CHECK (kind IN ('signup', 'bonus', 'bet', 'payout', 'refund')),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    market_id     INTEGER REFERENCES markets(id),
    note          TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX ledger_user ON ledger(user_id, id);

  UPDATE users SET balance = 100000;
  INSERT INTO ledger (user_id, kind, amount, balance_after, note, created_at)
    SELECT id, 'signup', 100000, 100000, '玩法升级为奖池模式，余额重置', CAST(unixepoch('subsec') * 1000 AS INTEGER)
      FROM users;
  `,
  /* 3: AI bots and the AI zone. Bots are ordinary accounts flagged is_bot; markets they create are
        is_ai and only those can take bot bets. ai_checked_at throttles the creator bot's attempts to
        look up the result; bot_attempts counts paid question-writing calls, failed ones included,
        against the daily cap. */ `
  ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE markets ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE markets ADD COLUMN ai_checked_at INTEGER;
  CREATE INDEX markets_ai ON markets(is_ai, status, close_at);

  CREATE TABLE bot_attempts (
    id         INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX bot_attempts_kind ON bot_attempts(kind, created_at);
  `,
  /* 4: WeCom (企业微信) bot. A binding ties one WeCom account to one site account; chat_id is the
        group where they last talked to the bot, which is where notices go. Bind tokens are stored
        hashed and single-use. Actions are money moves waiting for the owner to tap the confirmation
        card. Notices record which settlement messages and reminders were already sent. */ `
  CREATE TABLE wecom_bindings (
    wecom_userid TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL UNIQUE REFERENCES users(id),
    chat_id      TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE wecom_bind_tokens (
    token_hash   TEXT    PRIMARY KEY,
    wecom_userid TEXT    NOT NULL,
    chat_id      TEXT    NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX wecom_bind_tokens_user ON wecom_bind_tokens(wecom_userid);

  CREATE TABLE wecom_actions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    wecom_userid TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('bet', 'create', 'resolve', 'cancel')),
    payload      TEXT    NOT NULL,
    task_id      TEXT    NOT NULL UNIQUE,
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE wecom_notices (
    kind       TEXT    NOT NULL,
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, market_id)
  );
  `,
  /* 5: optional fully collateralized binary order books. Existing pool data is preserved. */ `
  ALTER TABLE markets ADD COLUMN mode TEXT NOT NULL DEFAULT 'pool' CHECK (mode IN ('pool', 'polymarket'));
  ALTER TABLE outcomes ADD COLUMN last_price INTEGER CHECK (last_price BETWEEN 1 AND 99);
  ALTER TABLE outcomes ADD COLUMN mark_price REAL NOT NULL DEFAULT 50;
  CREATE TABLE exchange_positions (
    user_id INTEGER NOT NULL REFERENCES users(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    market_id INTEGER NOT NULL REFERENCES markets(id),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= quantity),
    PRIMARY KEY (user_id, outcome_id)
  );
  CREATE INDEX exchange_positions_market ON exchange_positions(market_id);
  CREATE TABLE exchange_orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    market_id INTEGER NOT NULL REFERENCES markets(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 99),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= quantity),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX exchange_orders_book ON exchange_orders(market_id, status, outcome_id, side, price, id);
  CREATE TABLE exchange_trades (
    id INTEGER PRIMARY KEY,
    market_id INTEGER NOT NULL REFERENCES markets(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    maker_id INTEGER NOT NULL REFERENCES exchange_orders(id),
    taker_id INTEGER NOT NULL REFERENCES exchange_orders(id),
    price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 99),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    kind TEXT NOT NULL CHECK (kind IN ('transfer', 'mint', 'merge')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX exchange_trades_market ON exchange_trades(market_id, id);
  ALTER TABLE ledger RENAME TO old_ledger;
  CREATE TABLE ledger (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('signup', 'bonus', 'bet', 'payout', 'refund', 'split', 'merge', 'order_lock', 'order_release', 'sell')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    market_id INTEGER REFERENCES markets(id),
    note TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO ledger SELECT * FROM old_ledger;
  DROP TABLE old_ledger;
  CREATE INDEX ledger_user ON ledger(user_id, id);
  `,
  /* 6: user-scoped idempotent order submission for trading clients. */ `
  ALTER TABLE exchange_orders ADD COLUMN client_order_id TEXT;
  CREATE UNIQUE INDEX exchange_orders_client_id ON exchange_orders(user_id, client_order_id)
    WHERE client_order_id IS NOT NULL;
  `,
  /* 7: maker-only limit orders; existing orders keep their original behavior. */ `
  ALTER TABLE exchange_orders ADD COLUMN post_only INTEGER NOT NULL DEFAULT 0 CHECK (post_only IN (0, 1));
  `,
  /* 8: separate trading close from the earliest resolution time. */ `
  ALTER TABLE markets ADD COLUMN settle_at INTEGER NOT NULL DEFAULT 0;
  UPDATE markets SET settle_at = close_at;
  CREATE INDEX markets_settlement ON markets(status, settle_at);
  `,
  /* 9: instance admins. Admins toggle features (settings), restart the instance and adjust
        balances; every such action is kept in admin_audit. Balance adjustments are a new ledger
        kind, 'grant', which counts as funding like the signup and daily bonus. */ `
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE admin_audit (
    id         INTEGER PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES users(id),
    action     TEXT    NOT NULL,
    detail     TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  ALTER TABLE ledger RENAME TO old_ledger;
  CREATE TABLE ledger (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    kind          TEXT    NOT NULL CHECK (kind IN ('signup', 'bonus', 'bet', 'payout', 'refund', 'split', 'merge',
                                                   'order_lock', 'order_release', 'sell', 'grant')),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    market_id     INTEGER REFERENCES markets(id),
    note          TEXT,
    created_at    INTEGER NOT NULL
  );
  INSERT INTO ledger SELECT * FROM old_ledger;
  DROP TABLE old_ledger;
  CREATE INDEX ledger_user ON ledger(user_id, id);
  `,
  /* 10: Polymarket parity.
        - Order types: GTD orders expire at expires_at; FOK/FAK orders execute at once (market
          orders) and never rest; FOK/FAK buys may name an amount to spend instead of shares.
        - Multi-outcome markets (neg_risk): each option has its own Yes (token 0) and No (token 1)
          share with its own book; binary markets keep using token 0 of their Yes and No options.
        - Positions keep their average-cost basis (display only), backfilled from past fills and
          splits at 0.50 per share.
        - WeCom confirmation cards can place and cancel orders. */ `
  ALTER TABLE markets ADD COLUMN neg_risk INTEGER NOT NULL DEFAULT 0 CHECK (neg_risk IN (0, 1));

  ALTER TABLE exchange_orders ADD COLUMN token INTEGER NOT NULL DEFAULT 0 CHECK (token IN (0, 1));
  ALTER TABLE exchange_orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'GTC'
    CHECK (order_type IN ('GTC', 'GTD', 'FOK', 'FAK'));
  ALTER TABLE exchange_orders ADD COLUMN expires_at INTEGER;
  ALTER TABLE exchange_orders ADD COLUMN amount INTEGER CHECK (amount > 0);
  DROP INDEX exchange_orders_book;
  CREATE INDEX exchange_orders_book ON exchange_orders(market_id, status, outcome_id, token, side, price, id);
  CREATE INDEX exchange_orders_expiry ON exchange_orders(expires_at) WHERE status = 'open' AND expires_at IS NOT NULL;
  ALTER TABLE exchange_trades ADD COLUMN token INTEGER NOT NULL DEFAULT 0 CHECK (token IN (0, 1));

  ALTER TABLE exchange_positions RENAME TO old_exchange_positions;
  CREATE TABLE exchange_positions (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    token      INTEGER NOT NULL DEFAULT 0 CHECK (token IN (0, 1)),
    quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= quantity),
    cost       INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
    PRIMARY KEY (user_id, outcome_id, token)
  );
  INSERT INTO exchange_positions (user_id, outcome_id, market_id, token, quantity, reserved)
    SELECT user_id, outcome_id, market_id, 0, quantity, reserved FROM old_exchange_positions;
  DROP TABLE old_exchange_positions;
  CREATE INDEX exchange_positions_market ON exchange_positions(market_id);

  CREATE TEMP TABLE cost_basis AS
    SELECT user_id, outcome_id, SUM(q) AS q, SUM(c) AS c FROM (
      SELECT e.user_id, e.outcome_id, t.quantity AS q,
             t.quantity * CASE WHEN t.outcome_id = e.outcome_id THEN t.price ELSE 100 - t.price END AS c
        FROM exchange_trades t JOIN exchange_orders e ON e.id = t.maker_id OR e.id = t.taker_id
       WHERE e.side = 'buy'
      UNION ALL
      SELECT l.user_id, o.id, -l.amount / 100, -l.amount / 2
        FROM ledger l JOIN outcomes o ON o.market_id = l.market_id
       WHERE l.kind = 'split'
    ) GROUP BY user_id, outcome_id;
  UPDATE exchange_positions SET cost = COALESCE((
    SELECT CAST(ROUND(b.c * 1.0 * exchange_positions.quantity / b.q) AS INTEGER) FROM cost_basis b
     WHERE b.user_id = exchange_positions.user_id AND b.outcome_id = exchange_positions.outcome_id AND b.q > 0
  ), 0);
  DROP TABLE cost_basis;

  ALTER TABLE wecom_actions RENAME TO old_wecom_actions;
  CREATE TABLE wecom_actions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    wecom_userid TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('bet', 'create', 'resolve', 'cancel', 'order', 'cancel_order')),
    payload      TEXT    NOT NULL,
    task_id      TEXT    NOT NULL UNIQUE,
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
    created_at   INTEGER NOT NULL
  );
  INSERT INTO wecom_actions SELECT * FROM old_wecom_actions;
  DROP TABLE old_wecom_actions;
  `,
  /* 11: Polymarket mirror (the 'mimic' feature). Mirror markets are Polymarket-mode markets copied
        from polymarket.com events (markets.mimic_id is the event id): people trade them against the
        site at Polymarket's live prices, so their trades never move those prices, and positions
        (exchange_positions) settle at Polymarket's results.
        - markets: event slug, place in the current top K (NULL once it drops out), 24h volume (USD)
        - outcomes: the Polymarket market and CLOB tokens behind each option, the last synced best
          bid/ask of its first token (cents), whether it still trades, its final price (cents)
        - mimic_trades: every mirror trade, with its total in cents
        - ledger kind 'buy' for buying mirror shares; WeCom cards can trade mirrors ('mimic_order') */ `
  ALTER TABLE markets ADD COLUMN mimic_id TEXT;
  ALTER TABLE markets ADD COLUMN mimic_slug TEXT;
  ALTER TABLE markets ADD COLUMN mimic_rank INTEGER;
  ALTER TABLE markets ADD COLUMN mimic_volume REAL NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX markets_mimic ON markets(mimic_id) WHERE mimic_id IS NOT NULL;

  ALTER TABLE outcomes ADD COLUMN mimic_market_id TEXT;
  ALTER TABLE outcomes ADD COLUMN mimic_yes_token TEXT;
  ALTER TABLE outcomes ADD COLUMN mimic_no_token TEXT;
  ALTER TABLE outcomes ADD COLUMN mimic_bid REAL;
  ALTER TABLE outcomes ADD COLUMN mimic_ask REAL;
  ALTER TABLE outcomes ADD COLUMN mimic_open INTEGER NOT NULL DEFAULT 1 CHECK (mimic_open IN (0, 1));
  ALTER TABLE outcomes ADD COLUMN mimic_final REAL;

  CREATE TABLE mimic_trades (
    id         INTEGER PRIMARY KEY,
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
    token      INTEGER NOT NULL CHECK (token IN (0, 1)),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    side       TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    total      INTEGER NOT NULL CHECK (total >= 0),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX mimic_trades_market ON mimic_trades(market_id, id);
  CREATE INDEX mimic_trades_user ON mimic_trades(user_id, id);

  ALTER TABLE ledger RENAME TO old_ledger;
  CREATE TABLE ledger (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    kind          TEXT    NOT NULL CHECK (kind IN ('signup', 'bonus', 'bet', 'payout', 'refund', 'split', 'merge',
                                                   'order_lock', 'order_release', 'sell', 'grant', 'buy')),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    market_id     INTEGER REFERENCES markets(id),
    note          TEXT,
    created_at    INTEGER NOT NULL
  );
  INSERT INTO ledger SELECT * FROM old_ledger;
  DROP TABLE old_ledger;
  CREATE INDEX ledger_user ON ledger(user_id, id);

  ALTER TABLE wecom_actions RENAME TO old_wecom_actions;
  CREATE TABLE wecom_actions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    wecom_userid TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('bet', 'create', 'resolve', 'cancel', 'order', 'cancel_order', 'mimic_order')),
    payload      TEXT    NOT NULL,
    task_id      TEXT    NOT NULL UNIQUE,
    status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
    created_at   INTEGER NOT NULL
  );
  INSERT INTO wecom_actions SELECT * FROM old_wecom_actions;
  DROP TABLE old_wecom_actions;
  `,
];
