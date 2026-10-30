// Builds infra/n8n-credentials.json (git-ignored) from .env. n8n encrypts the data on import.
// Options: --from-env    take the settings from the environment instead of .env (the server installer runs this in a
//                        container whose environment holds infra/hostinger/.env)
//          --out <file>  where to write (default infra/n8n-credentials.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
// Values may be quoted as in a shell file (GOOGLE_SA_KEY="-----BEGIN PRIVATE KEY-----\n...").
const unquote = (v) => (/^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v);
const env = process.argv.includes('--from-env') ? process.env : Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), unquote(l.slice(l.indexOf('=') + 1).trim())]),
);
const creds = [
  // Google Sheets (the data store) and Google Drive (the knowledge folder) through a service account. The spreadsheet and
  // the folder are shared with GOOGLE_SA_EMAIL. Without it the workflow is built for the local stand-in (SHEETS_AUTH=none)
  // and this credential is a placeholder.
  { id: 'credGoogleSA0001', name: 'Google Sheets & Drive (service account)', type: 'googleApi',
    data: { region: 'global', email: env.GOOGLE_SA_EMAIL || 'not-configured@example.iam.gserviceaccount.com',
            privateKey: (env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n'), inpersonate: false, httpNode: true,
            scopes: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly' } },
  { id: 'credGeminiApi001', name: 'Gemini (Google AI Studio)', type: 'googlePalmApi',
    data: { host: env.GEMINI_BASE_URL || 'http://gemini:8092', apiKey: env.GEMINI_API_KEY || 'missing-key' } },
  // MedGemma may run on a different machine than the embeddings model (e.g. a home GPU over Tailscale).
  { id: 'credOllamaLocal1', name: 'Ollama (MedGemma)', type: 'ollamaApi',
    data: { baseUrl: env.MEDGEMMA_URL || env.OLLAMA_URL || 'http://host.docker.internal:11434' } },
  // Optional. Without SMTP_HOST the credential is a placeholder and the email workflow does nothing (flag email_delivery off).
  { id: 'credSmtpMail0001', name: 'Email (SMTP)', type: 'smtp',
    data: { host: env.SMTP_HOST || 'smtp.invalid', port: Number(env.SMTP_PORT || 587), user: env.SMTP_USER || '', password: env.SMTP_PASSWORD || '',
            secure: String(env.SMTP_PORT || '587') === '465', disableStartTls: env.SMTP_STARTTLS === 'false' } },
];
const out = arg('--out') ? resolve(arg('--out')) : new URL('../infra/n8n-credentials.json', import.meta.url);
writeFileSync(out, JSON.stringify(creds, null, 2), { mode: 0o600 });
console.log(`credentials written (Gemini key ${env.GEMINI_API_KEY ? 'present' : 'MISSING - AI uses fallbacks until you add it'}; Google service account ${env.GOOGLE_SA_EMAIL ? 'present' : 'not set - local Sheets stand-in'})`);
