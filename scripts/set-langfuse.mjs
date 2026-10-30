// Starts Langfuse (open source LLM tracing) in Docker on this computer and connects the platform to it.
//   node scripts/set-langfuse.mjs            first run: random secrets and API keys, start, wait, restart n8n
//   node scripts/set-langfuse.mjs --off      stop sending traces (the Langfuse containers keep their data)
// Secrets go to infra/langfuse/.env (git-ignored); the platform's .env gets LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and
// LANGFUSE_SECRET_KEY. Traces carry metadata only (workflow, status, model, latency, release, risk signals, judge
// scores): no message text, no patient or user id. UI: http://localhost:3010
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const envFile = new URL('.env', root), lfEnv = new URL('infra/langfuse/.env', root);
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const get = (s, k) => (s.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
const set = (s, k, v) => (new RegExp(`^${k}=`, 'm').test(s) ? s.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${s.replace(/\n?$/, '\n')}${k}=${v}\n`);
const hex = (n) => randomBytes(n).toString('hex');
const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', cwd: new URL('.', root), env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

let env = read(envFile);
if (process.argv.includes('--off')) {
  env = set(env, 'LANGFUSE_PUBLIC_KEY', '');
  writeFileSync(envFile, env);
  run('docker', ['compose', '-f', 'infra/docker-compose.yml', '--env-file', '.env', 'up', '-d', 'n8n']);
  console.log('Tracing is off (Langfuse keeps its data; stop it with: docker compose -f infra/langfuse/docker-compose.yml down).');
  process.exit(0);
}

let lf = read(lfEnv);
const keep = (k, v) => { if (!get(lf, k)) lf = set(lf, k, v); };
keep('LF_PG_PASSWORD', hex(12));
keep('LF_CH_PASSWORD', hex(12));
keep('LF_MINIO_PASSWORD', hex(12));
keep('LF_REDIS_PASSWORD', hex(12));
keep('LF_SALT', hex(16));
keep('LF_ENCRYPTION_KEY', hex(32));
keep('LF_NEXTAUTH_SECRET', hex(24));
keep('LANGFUSE_PUBLIC_KEY', `pk-lf-${hex(16)}`);
keep('LANGFUSE_SECRET_KEY', `sk-lf-${hex(16)}`);
keep('LANGFUSE_INIT_USER_EMAIL', 'evaluation@demo.health');
keep('LANGFUSE_INIT_USER_PASSWORD', `Lf-${hex(6)}`);
writeFileSync(lfEnv, lf);

console.log('==> Starting Langfuse (first start downloads the images, a few minutes)');
const up = run('docker', ['compose', '-f', 'infra/langfuse/docker-compose.yml', '--env-file', 'infra/langfuse/.env', 'up', '-d']);
if (up.status !== 0) process.exit(up.status || 1);

process.stdout.write('Waiting for Langfuse');
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  try { ready = (await fetch('http://localhost:3010/api/public/health')).ok; } catch { /* starting */ }
  if (!ready) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 3000)); }
}
console.log(ready ? ' ready' : ' not ready yet (check: docker compose -f infra/langfuse/docker-compose.yml logs langfuse-web)');

// n8n reaches Langfuse on the host (extra_hosts host.docker.internal is set for the n8n service).
env = set(env, 'LANGFUSE_HOST', 'http://host.docker.internal:3010');
env = set(env, 'LANGFUSE_PUBLIC_KEY', get(lf, 'LANGFUSE_PUBLIC_KEY'));
env = set(env, 'LANGFUSE_SECRET_KEY', get(lf, 'LANGFUSE_SECRET_KEY'));
writeFileSync(envFile, env);
// --no-restart: n8n picks the keys up at the next deploy (scripts/deploy-workflows.sh) instead of now.
if (!process.argv.includes('--no-restart')) run('docker', ['compose', '-f', 'infra/docker-compose.yml', '--env-file', '.env', 'up', '-d', 'n8n']);

if (ready) {
  const auth = Buffer.from(`${get(lf, 'LANGFUSE_PUBLIC_KEY')}:${get(lf, 'LANGFUSE_SECRET_KEY')}`).toString('base64');
  const id = `setup-${hex(6)}`;
  const r = await fetch('http://localhost:3010/api/public/ingestion', { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch: [{ id, type: 'trace-create', timestamp: new Date().toISOString(), body: { id, name: 'setup check', tags: ['setup'], metadata: { source: 'set-langfuse.mjs' } } }] }) });
  console.log(`Test trace: HTTP ${r.status}`);
}
console.log(`\nLangfuse: http://localhost:3010  sign in as ${get(lf, 'LANGFUSE_INIT_USER_EMAIL')} / ${get(lf, 'LANGFUSE_INIT_USER_PASSWORD')}`);
console.log('The platform sends every finished AI run and job run there every 2 minutes (WF-030).');
