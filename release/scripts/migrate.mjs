#!/usr/bin/env node
/**
 * Database migration runner
 * Usage:
 *   node scripts/migrate.mjs             — run all pending migrations
 *   node scripts/migrate.mjs --status    — show migration status
 *   node scripts/migrate.mjs --rollback  — drop schema_migrations table (emergency)
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, '../migrations/sql');

const PG_URL = process.env.PG_URL || process.env.DATABASE_URL;
if (!PG_URL) {
  console.error('Error: PG_URL environment variable is not set');
  process.exit(1);
}

async function getClient() {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  return client;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT UNIQUE NOT NULL,
      applied_at  TIMESTAMPTZ DEFAULT now()
    )
  `);
}

async function getApplied(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations ORDER BY id');
  return new Set(rows.map(r => r.filename));
}

function getMigrationFiles() {
  return fs.readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function runMigrations(client) {
  const applied = await getApplied(client);
  const files = getMigrationFiles();
  const pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log('✓ All migrations are up to date');
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    console.log(`→ Running ${file}...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓ ${file} applied`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${file} failed: ${err.message}`);
      throw err;
    }
  }
}

async function showStatus(client) {
  const applied = await getApplied(client);
  const files = getMigrationFiles();

  console.log('\nMigration Status:');
  console.log('─'.repeat(50));
  for (const file of files) {
    const status = applied.has(file) ? '✓ applied' : '○ pending';
    console.log(`  ${status}  ${file}`);
  }
  console.log('─'.repeat(50));
  console.log(`  Applied: ${applied.size} / ${files.length}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const isStatus = args.includes('--status');
  const isRollback = args.includes('--rollback');

  const client = await getClient();

  try {
    await ensureMigrationTable(client);

    if (isRollback) {
      await client.query('DROP TABLE IF EXISTS schema_migrations');
      console.log('schema_migrations table dropped');
    } else if (isStatus) {
      await showStatus(client);
    } else {
      await runMigrations(client);
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
