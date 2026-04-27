CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  subdomain TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'starter',
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active DATETIME
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- Phase 4: Anthropic API key support
ALTER TABLE clients ADD COLUMN anthropic_api_key TEXT;

CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  call_id TEXT UNIQUE NOT NULL,
  agent_id TEXT,
  from_number TEXT,
  to_number TEXT,
  direction TEXT DEFAULT 'outbound',
  status TEXT DEFAULT 'completed',
  duration_seconds INTEGER,
  recording_url TEXT,
  transcript TEXT,
  sentiment TEXT,
  resolved INTEGER DEFAULT 0,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);
