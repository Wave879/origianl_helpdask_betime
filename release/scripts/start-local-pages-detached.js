import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const tmpDir = path.join(root, '.tmp');
const xdgDir = path.join(tmpDir, 'xdg');
const preferredPort = Number(String(process.env.LOCAL_PAGES_PORT || process.env.PORT || '8788').trim() || '8788');
for (const dir of [tmpDir, xdgDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: port }, () => {
      const addr = server.address();
      server.close(() => resolve(Boolean(addr)));
    });
  });
}

async function resolvePort() {
  if (Number.isInteger(preferredPort) && preferredPort > 0 && await isPortFree(preferredPort)) {
    return preferredPort;
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = server.address();
      const chosen = typeof addr === 'object' && addr ? addr.port : 8788;
      server.close(() => resolve(chosen));
    });
  });
}

const port = String(await resolvePort());
fs.writeFileSync(path.join(tmpDir, 'betime-local-port.txt'), `${port}\n`);

const env = { ...process.env };
env.XDG_CONFIG_HOME = xdgDir;
env.WRANGLER_HOME = xdgDir;
env.CD = root;

const devVarsPath = path.join(root, '.dev.vars');
if (fs.existsSync(devVarsPath)) {
  const devVars = fs.readFileSync(devVarsPath, 'utf8').split(/\r?\n/);
  for (const line of devVars) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name && !env[name]) env[name] = value;
  }
}

const bindingNames = [
  'PG_URL',
  'AZURE_AI_URL',
  'AZURE_AI_KEY',
  'AZURE_AI_MODEL',
  'AZURE_AI_ENDPOINT',
  'AZURE_AI_DEPLOYMENT',
  'AZURE_AI_API_VERSION',
  'AZURE_AI_MODELS_CHAT_URL',
  'AZURE_AI_MODELS_CHAT_KEY',
  'AZURE_AI_MODELS_CHAT_MODEL',
  'AZURE_AI_MODELS_CHAT_ENDPOINT',
  'AZURE_AI_MODELS_CHAT_DEPLOYMENT',
  'AZURE_AI_MODELS_CHAT_API_VERSION',
  'AZURE_OPENAI_CHAT_URL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_KEY',
  'OAI_ENDPOINT',
  'OAI_DEPLOY',
  'OAI_EMBEDDING_DEPLOY',
  'OAI_API_VERSION',
  'OAI_KEY',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_API_PROVIDER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_EMBEDDING_MODEL',
  'OPENROUTER_EMBEDDING_URL',
  'OPENROUTER_HTTP_REFERER',
  'OPENROUTER_APP_TITLE',
  'QDRANT_BRIDGE_API_KEY',
  'QDRANT_BRIDGE_ALLOW_UNAUTH',
  'QDRANT_URL',
  'QDRANT_CLUSTER_URL',
  'QDRANT_ENDPOINT',
  'QDRANT_DB_API_KEY',
  'QDRANT_CLOUD_API_KEY',
  'QDRANT_DATABASE_API_KEY',
  'QDRANT_COLLECTION',
  'QDRANT_DISTANCE',
  'AZURE_SPEECH_KEY',
  'AZURE_SPEECH_ENDPOINT',
  'AZURE_SPEECH_REGION',
  'AZURE_KEY',
  'AZURE_REGION',
  'MAI_KEY',
  'MAI_REGION',
  'ODOO_URL',
  'ODOO_DB',
  'ODOO_LOGIN',
  'ODOO_PASSWORD',
  'ODOO_CHANNEL',
  'ODOO_DIRECT_CREATE',
  'ODOO_LOCAL_FALLBACK',
];

const defaultBindings = {
  PG_URL: env.PG_URL || 'postgres://postgres:123456@localhost:5432/Betime_DB',
  ODOO_URL: env.ODOO_URL || env.ODOO_BASE_URL || 'http://bt.dev.demotoday.net',
  ODOO_DB: env.ODOO_DB || 'bt-helpdesk',
  ODOO_LOGIN: env.ODOO_LOGIN || 'admin',
  ODOO_PASSWORD: env.ODOO_PASSWORD || 'bt@admin',
  ODOO_CHANNEL: env.ODOO_CHANNEL || 'Website',
  ODOO_DIRECT_CREATE: env.ODOO_DIRECT_CREATE || '1',
  ODOO_LOCAL_FALLBACK: env.ODOO_LOCAL_FALLBACK || '1',
};
for (const [name, value] of Object.entries(defaultBindings)) {
  if (!env[name] && value) env[name] = value;
}

const runCmd = path.join(tmpDir, `run-helpdesk-local-${port}-${Date.now()}.cmd`);
const bindingArgs = bindingNames
  .filter((name) => env[name] && String(env[name]).trim())
  .map((name) => ` -b "${name}=%${name}%"`)
  .join('');
const envLines = bindingNames
  .filter((name) => env[name] && String(env[name]).trim())
  .map((name) => `set "${name}=%${name}%"`)
  .join('\r\n');

fs.writeFileSync(
  runCmd,
  `@echo off\r\nset "XDG_CONFIG_HOME=${xdgDir}"\r\nset "WRANGLER_HOME=%XDG_CONFIG_HOME%"\r\n${envLines}\r\ncd /d "${root}"\r\ncall npx wrangler pages dev deploy/pages_bundle --port ${port} --compatibility-date 2026-04-27${bindingArgs}\r\n`
);

const args = ['/d', '/s', '/c', `"${runCmd}"`];
const child = spawn('cmd.exe', args, {
  cwd: root,
  env,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.unref();
console.log(`Started local Pages worker pid=${child.pid} port=${port}`);
