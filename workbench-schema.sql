-- Explicit migration, never run automatically on HTTP requests.
BEGIN;
CREATE TABLE IF NOT EXISTS wb_settings (id integer PRIMARY KEY CHECK(id=1), key_check text NOT NULL);
CREATE TABLE IF NOT EXISTS wb_cards (
 id uuid PRIMARY KEY, channel text NOT NULL, product text NOT NULL,
 digest text NOT NULL UNIQUE, secret text NOT NULL, hint text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','available','reserved','issued','used','quarantine')),
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wb_cards_pool ON wb_cards(channel,product,state,created_at);
CREATE TABLE IF NOT EXISTS wb_orders (
 id uuid PRIMARY KEY, request_key text NOT NULL UNIQUE, fingerprint text NOT NULL,
 card_id uuid NOT NULL REFERENCES wb_cards(id), channel text NOT NULL, product text NOT NULL,
 source text NOT NULL DEFAULT 'admin', identity text NOT NULL, identity_hash text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','processing','success','failed','unknown')),
 task_id text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(), next_check timestamptz NOT NULL DEFAULT now() + interval '3 minutes'
);
CREATE INDEX IF NOT EXISTS wb_orders_query ON wb_orders(state,next_check);
CREATE UNIQUE INDEX IF NOT EXISTS wb_orders_active_target ON wb_orders(channel,product,identity_hash) WHERE source='admin' AND state IN ('pending','processing','unknown');
CREATE TABLE IF NOT EXISTS wb_public_claims (digest text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wb_batches (id uuid PRIMARY KEY, request_key text NOT NULL UNIQUE, channel text NOT NULL, product text NOT NULL, quantity integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wb_issued (batch_id uuid REFERENCES wb_batches(id), card_id uuid REFERENCES wb_cards(id), PRIMARY KEY(batch_id,card_id));
CREATE TABLE IF NOT EXISTS wb_sessions (digest text PRIMARY KEY, csrf text NOT NULL, expires_at timestamptz NOT NULL, elevated_until timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS wb_auth (id integer PRIMARY KEY CHECK(id=1), last_totp bigint NOT NULL DEFAULT -1, attempts integer NOT NULL DEFAULT 0, window_at timestamptz NOT NULL DEFAULT now());
INSERT INTO wb_auth(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS wb_audit (id bigserial PRIMARY KEY, action text NOT NULL, target text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
COMMIT;
