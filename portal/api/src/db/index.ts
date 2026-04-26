import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DATABASE_PATH || './portal.db';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function initDb(): void {
  const db = getDb();
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Seed default admin
  const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get('admin@clawbridgeagency.com');
  if (!existing) {
    const hash = bcrypt.hashSync('changeme', 10);
    db.prepare(
      'INSERT INTO admins (id, email, password_hash) VALUES (?, ?, ?)'
    ).run(randomUUID(), 'admin@clawbridgeagency.com', hash);
    console.log('Default admin created: admin@clawbridgeagency.com / changeme');
  }
}
