import pg from 'pg';

const { Client } = pg;
const PG_URL = process.env.PG_URL;
const timeoutMs = Number(process.env.PG_WAIT_TIMEOUT_MS || 60000);
const intervalMs = Number(process.env.PG_WAIT_INTERVAL_MS || 2000);

if (!PG_URL) {
  console.error('PG_URL is required');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedAt = Date.now();
let lastError = null;

while (Date.now() - startedAt < timeoutMs) {
  const client = new Client({ connectionString: PG_URL });
  try {
    await client.connect();
    await client.end();
    process.exit(0);
  } catch (err) {
    lastError = err;
    try {
      await client.end();
    } catch {
      // ignore cleanup errors while waiting for the database
    }
    await sleep(intervalMs);
  }
}

console.error(`Timed out waiting for PostgreSQL after ${timeoutMs}ms`);
if (lastError) {
  console.error(lastError.message || String(lastError));
}
process.exit(1);
