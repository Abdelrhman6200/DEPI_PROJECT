// Web push section (WF-027). The engine picks what to send (29_push_privacy.js: daily cap, quiet hours, a generic text
// with no health details); this section encrypts each message for the browser (RFC 8291, aes128gcm), signs the request
// with the platform's VAPID key (RFC 8292) and posts it to the browser's push service. Free: no push provider account.
// Keys: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT in .env (scripts/set-vapid-keys.mjs). Without them the
// section does nothing and notifications stay in the app only.
import { workflow, jsStep, code, ifTrue, schedule, subTrigger, WF } from './lib.mjs';

const ENCRYPT = String.raw`
const crypto = require('crypto');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const pub = unb64u($env.VAPID_PUBLIC_KEY);
const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64u(unb64u($env.VAPID_PRIVATE_KEY)),
  x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
const subject = $env.VAPID_SUBJECT || 'mailto:admin@example.com';
const jwts = {};
function vapid(endpoint) {
  // The audience is the push service's origin (the task runner has no URL global).
  const aud = (String(endpoint).match(/^https:\/\/[^/]+/) || [''])[0];
  if (!jwts[aud]) {
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
    const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
    jwts[aud] = head + '.' + body + '.' + b64u(sig);
  }
  return 'vapid t=' + jwts[aud] + ', k=' + $env.VAPID_PUBLIC_KEY;
}
// RFC 8291: one record, the payload followed by the 0x02 delimiter, encrypted with a key agreed with the browser's key.
function encrypt(payload, p256dh, auth) {
  const ua = unb64u(p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const ikm = hkdf(unb64u(auth), ecdh.computeSecret(ua), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, enc]);
}
const out = [];
for (const it of $input.all()) {
  const m = it.json;
  try {
    out.push({ json: { subscription_id: m.subscription_id, endpoint: m.endpoint, authorization: vapid(m.endpoint), ttl: String(m.ttl || 3600), urgency: m.urgency || 'normal' },
      binary: { data: { data: encrypt(m.payload, m.p256dh, m.auth).toString('base64'), mimeType: 'application/octet-stream', fileName: 'push.bin' } } });
  } catch (e) {
    out.push({ json: { subscription_id: m.subscription_id, endpoint: null, error: String(e.message || e).slice(0, 200) } });
  }
}
return out;`;

/** WF-027: every 2 minutes, unread notifications become one push per person (rule push_policy). */
export function pushDelivery() {
  const wf = workflow({ id: WF.push, name: 'WF-027 · Web push delivery', description: 'Every 2 minutes, sends new notifications as web push to the browsers people allowed (one per person per run, daily cap, quiet hours except urgent kinds). The push text is generic; details stay in the app. Needs VAPID keys in .env.' });
  const t = wf.add(schedule('Every 2 minutes', { field: 'minutes', minutesInterval: 2 }));
  const now = wf.add(subTrigger('Run now'));
  const on = wf.add(ifTrue('Push keys set?', '!!$env.VAPID_PUBLIC_KEY && !!$env.VAPID_PRIVATE_KEY'));
  const batch = wf.add(jsStep('Pushes to send', 'fn_push_batch()', '[]', { mode: 'rows' }));
  const enc = wf.add(code('Encrypt and sign', ENCRYPT));
  const send = wf.add({
    name: 'Send to push service',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      // Only the browser push services: the engine refused any other address when the browser subscribed.
      url: "={{ $json.endpoint || 'https://fcm.googleapis.com/invalid' }}",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Authorization', value: '={{ $json.authorization }}' },
        { name: 'TTL', value: '={{ $json.ttl }}' },
        { name: 'Urgency', value: '={{ $json.urgency }}' },
        { name: 'Content-Encoding', value: 'aes128gcm' },
        { name: 'Content-Type', value: 'application/octet-stream' },
      ] },
      sendBody: true,
      contentType: 'binaryData',
      inputDataFieldName: 'data',
      options: { timeout: 10000, redirect: { redirect: { followRedirects: false } }, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } },
    },
  });
  const collect = wf.add(code('Results', `
const sent = $('Encrypt and sign').all();
// The push service's answer (or why nothing was sent) is kept on the subscription (last_status, last_error).
const results = $input.all().map((it, i) => {
  const j = it.json || {}, e = j.error || {};
  const status = sent[i] && sent[i].json.endpoint ? Number(j.statusCode || e.httpCode || e.status || 0) : 0;
  const error = sent[i] && sent[i].json.error ? sent[i].json.error : status >= 200 && status < 300 ? null
    : String(e.message || e.description || j.body || '').slice(0, 300);
  return { subscription_id: sent[i] ? sent[i].json.subscription_id : null, status, error };
});
return [{ json: { results } }];`));
  const record = wf.add(jsStep('Record results', 'fn_push_results(castJson(a[0]))', '[ JSON.stringify($json.results) ]'));
  wf.link(t, on);
  wf.link(now, on);
  wf.link(on, batch, { output: 0 });
  wf.chain(batch, enc, send, collect, record);
  return wf.build();
}
