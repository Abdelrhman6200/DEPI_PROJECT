// The web push public key (VAPID), read at run time so one built image works with any key pair. The private key never
// reaches the web app: it stays in n8n, which signs and sends the pushes (workflows/src/push.mjs).
export const dynamic = 'force-dynamic';

export function GET() {
  const key = process.env.VAPID_PUBLIC_KEY || '';
  return Response.json({ key: /^[A-Za-z0-9_-]{80,100}$/.test(key) ? key : null }, { headers: { 'Cache-Control': 'no-store' } });
}
