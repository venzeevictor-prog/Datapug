-- DataPlug — cheap Nigerian data bundle reseller. Database Schema

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'customer', -- 'customer' | 'support' | 'admin' | 'super_admin'
    is_active BOOLEAN NOT NULL DEFAULT true,
    totp_secret VARCHAR(64), -- base32 TOTP secret, set once 2FA setup begins
    totp_enabled BOOLEAN NOT NULL DEFAULT false, -- true only after the user confirms a code
    totp_backup_codes TEXT[], -- hashed one-time backup codes for account recovery
    -- ============ Referral program ============
    referral_code VARCHAR(20) UNIQUE NOT NULL DEFAULT substr(md5(random()::text), 1, 8), -- shareable code; unique constraint means a collision just fails the insert (astronomically unlikely at this length)
    referred_by INTEGER REFERENCES users(id), -- set once at signup from a ?ref= link, never changed after
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Password reset tokens. We store a HASH of the token (never the raw token) so a DB leak
-- alone can't be used to reset accounts; the raw token only ever exists in the emailed link.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One wallet per user. Balance stored in kobo (integer) to avoid float rounding issues.
CREATE TABLE IF NOT EXISTS wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance BIGINT NOT NULL DEFAULT 0, -- in kobo (₦1 = 100 kobo)
    currency VARCHAR(10) NOT NULL DEFAULT 'NGN',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every wallet movement is logged here. This is the source-of-truth ledger;
-- wallets.balance is a cached sum for fast reads (see services/reconcile.js for how
-- the two are kept in sync, and scripts/repair-wallet-balance.js if they ever drift).
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'funding' | 'order_debit' | 'refund' | 'adjustment' | 'referral_bonus'
    amount BIGINT NOT NULL, -- always positive; direction implied by type
    balance_before BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    reference VARCHAR(100) UNIQUE NOT NULL, -- our internal ref, or Paystack ref for funding
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'success' | 'failed'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Upstream providers ============
-- VTPass today; room for a second data reseller later without touching code, same as
-- the FSS panel's provider pattern. api_key/secret_key/public_key: VTPass specifically
-- needs three separate credentials (not one, unlike the SMM/logs providers this table
-- was originally built for) — see services/vtpass.js for which is used where.
CREATE TABLE IF NOT EXISTS providers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) UNIQUE NOT NULL,
    api_url TEXT NOT NULL,
    api_key TEXT NOT NULL, -- stored as-is for now — encrypt at rest before real production volume
    secret_key TEXT, -- required for vtpass (purchase/requery calls)
    public_key TEXT, -- required for vtpass (read-only calls: variation codes, wallet balance)
    api_type VARCHAR(50) NOT NULL DEFAULT 'vtpass', -- selects which connector logic to use
    markup_multiplier NUMERIC(6,4) NOT NULL DEFAULT 1.15,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Data plan catalog: networks -> plans (duration lives on the plan) ============
-- VTPass has no structured "duration" field — a plan's name is a free-text string like
-- "N1500 6GB - 7 days" or "MTN N50,000 165GB SME Mobile Data (2-Months)". `duration` here
-- is PARSED out of that name at sync time (see services/vtpass.js classifyDuration) into
-- one of a small fixed set — it is inferred, not authoritative, and worth spot-checking
-- after your first sync.
CREATE TABLE IF NOT EXISTS networks (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL, -- 'MTN' | 'Glo' | 'Airtel' | '9mobile'
    slug VARCHAR(20) UNIQUE NOT NULL,
    vtpass_service_id VARCHAR(50) UNIQUE NOT NULL, -- 'mtn-data' | 'glo-data' | 'airtel-data' | 'etisalat-data'
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS data_plans (
    id SERIAL PRIMARY KEY,
    network_id INTEGER NOT NULL REFERENCES networks(id),
    provider_id INTEGER NOT NULL REFERENCES providers(id),
    provider_variation_code VARCHAR(100) NOT NULL, -- VTPass's variation_code — required at purchase time
    raw_name VARCHAR(255) NOT NULL, -- exactly what VTPass called it, kept for reference/debugging the duration parse
    data_size VARCHAR(50), -- parsed display value, e.g. "6GB" — nullable if the name didn't parse cleanly
    duration VARCHAR(20) NOT NULL DEFAULT 'other', -- 'weekly' | 'monthly' | '2-3months' | 'other' (see classifyDuration)
    provider_price NUMERIC(12,2) NOT NULL, -- what VTPass charges us, in naira
    price NUMERIC(12,2) NOT NULL, -- what we charge the customer, in naira
    custom_price BOOLEAN NOT NULL DEFAULT false, -- true once an admin manually overrides price; sync then leaves it alone
    is_active BOOLEAN NOT NULL DEFAULT true, -- lets you hide a plan (e.g. an 'other'-duration one) without deleting it
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(network_id, provider_variation_code)
);

-- Purchases are NOT always synchronous — VTPass can return "pending" (see their sandbox
-- timeout/no-response scenarios) and needs a follow-up requery. status therefore has a
-- real in-between state, unlike the logs-marketplace pattern this was adapted from.
CREATE TABLE IF NOT EXISTS data_orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES data_plans(id),
    phone_number VARCHAR(20) NOT NULL, -- the number that receives the data — may differ from the buyer's own number
    provider_request_id VARCHAR(50) UNIQUE NOT NULL, -- our generated VTPass request_id (see services/vtpass.js buildRequestId)
    provider_transaction_id VARCHAR(100),
    charge BIGINT NOT NULL, -- amount debited from customer's wallet, in kobo (REVENUE)
    provider_cost BIGINT NOT NULL DEFAULT 0, -- what this order cost us, in kobo (COST)
    profit BIGINT NOT NULL DEFAULT 0, -- charge - provider_cost
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'failed'
    provider_response JSONB DEFAULT '{}', -- last raw VTPass response, for support/debugging
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Referral program ============
-- One row per referred signup, not per reward — this exists to make the reward
-- idempotent (a referred user's qualifying deposit can only ever pay out once) and to
-- give you a real audit trail of who referred whom and when they converted.
CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, -- a user can only ever be "referred" once
    reward_amount BIGINT NOT NULL, -- kobo, snapshotted at signup time so a later change to REFERRAL_BONUS_NAIRA doesn't retroactively change pending rewards
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' (referred user hasn't hit the deposit threshold yet) | 'rewarded'
    rewarded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Customer support chat ============
CREATE TABLE IF NOT EXISTS support_conversations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    assigned_agent_id INTEGER REFERENCES users(id),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    sender_role VARCHAR(20) NOT NULL,
    body TEXT NOT NULL,
    read_by_customer BOOLEAN NOT NULL DEFAULT false,
    read_by_agent BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Audit log ============
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),
    target_id VARCHAR(50),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Website stats ============
-- One row per page load (from public/js/track.js beacon). This is what powers the
-- daily/monthly/date-range analytics dashboard — see routes/admin.js stats endpoints.
CREATE TABLE IF NOT EXISTS page_views (
    id SERIAL PRIMARY KEY,
    visitor_id VARCHAR(64) NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    path VARCHAR(500) NOT NULL,
    referrer TEXT,
    ip_address VARCHAR(64),
    device_type VARCHAR(20),
    browser VARCHAR(50),
    browser_version VARCHAR(20),
    os VARCHAR(50),
    country VARCHAR(100),
    region VARCHAR(100),
    city VARCHAR(100),
    screen_width INTEGER,
    screen_height INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_page_views_visitor_id ON page_views(visitor_id);
CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_data_orders_user_id ON data_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_data_orders_status ON data_orders(status);
CREATE INDEX IF NOT EXISTS idx_data_orders_created_at ON data_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_data_plans_network_id ON data_plans(network_id);
CREATE INDEX IF NOT EXISTS idx_data_plans_duration ON data_plans(duration);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_support_conversations_status ON support_conversations(status);
CREATE INDEX IF NOT EXISTS idx_support_conversations_user_id ON support_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation_id ON support_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

-- Seed the four networks. VTPass's serviceIDs are stable/documented, safe to hardcode.
INSERT INTO networks (name, slug, vtpass_service_id) VALUES
    ('MTN', 'mtn', 'mtn-data'),
    ('Glo', 'glo', 'glo-data'),
    ('Airtel', 'airtel', 'airtel-data'),
    ('9mobile', '9mobile', 'etisalat-data')
ON CONFLICT (slug) DO NOTHING;
