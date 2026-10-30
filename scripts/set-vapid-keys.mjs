// Creates the web push key pair (VAPID, RFC 8292) once and saves it in .env: VAPID_PUBLIC_KEY (given to browsers),
// VAPID_PRIVATE_KEY (signs push requests; stays in n8n) and VAPID_SUBJECT (a contact the push services can use).
// Free: browsers' push services need no account. Keeping the same keys keeps existing subscriptions working.
// Usage: node scripts/set-vapid-keys.mjs [mailto:you@example.com]      (--rotate makes a new pair: every device must
//        allow notifications again)
//        --env <file> writes another env file instead of .env, e.g. --env infra/hostinger/.env for the production
//        server (give each server a pair of its own; never copy the keys of this computer)
// Then restart n8n and the web container: docker compose -f infra/docker-compose.yml --env-file .env up -d n8n web
// (production: run scripts/deploy-hostinger.sh again).
import { createECDH } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const envArg = process.argv.indexOf('--env');
const envName = envArg > 0 ? process.argv[envArg + 1] : '';
if (envArg > 0 && !envName) { console.error('--env needs a file name, e.g. --env infra/hostinger/.env'); process.exit(1); }
const file = envName ? new URL(envName, pathToFileURL(`${process.cwd()}/`)) : new URL('../.env', import.meta.url);
let env = existsSync(file) ? readFileSync(file, 'utf8') : '';
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
const set = (k, v) => { env = new RegExp(`^${k}=`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.replace(/\n?$/, '\n')}${k}=${v}\n`; };
const rotate = process.argv.includes('--rotate');
const subject = process.argv.slice(2).find((a) => a.startsWith('mailto:') || a.startsWith('https://'));
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
if (get('VAPID_PUBLIC_KEY') && get('VAPID_PRIVATE_KEY') && !rotate) {
  console.log('Web push keys already set (use --rotate for a new pair).');
} else {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  set('VAPID_PUBLIC_KEY', b64u(ecdh.getPublicKey()));
  set('VAPID_PRIVATE_KEY', b64u(ecdh.getPrivateKey()));
  console.log('Web push keys created.');
}
if (subject || !get('VAPID_SUBJECT')) set('VAPID_SUBJECT', subject || 'mailto:admin@example.com');
writeFileSync(file, env);
console.log(`Saved in ${envName || '.env'}. Public key: ${get('VAPID_PUBLIC_KEY').slice(0, 16)}...`);
