import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

// Rewrites are resolved at build time: set N8N_URL before `next build` (Docker passes it as a build arg).
const N8N_URL = process.env.N8N_URL ?? 'http://localhost:5678';
const standalone = process.env.NEXT_OUTPUT === 'standalone';
// Each build gets its own id: the service worker is registered as /sw.js?v=<id>, so a new build replaces the
// offline caches of the previous one instead of serving its old files.
const VERSION = (JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version?: string }).version ?? '0';
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || `${VERSION}-${Date.now().toString(36)}`;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No "X-Powered-By: Next.js" header: it only tells a visitor what to attack.
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  transpilePackages: ['@health/api-client'],
  // AI calls (Companion, pre-visit brief) can take 10-120 s; the default rewrite proxy timeout is 30 s.
  experimental: { proxyTimeout: 300_000 },
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: path.join(__dirname, '../..') } : {}),
  async rewrites() {
    // Only the API is forwarded: /n8n/api/v1/<group>, with the group limited to letters. A catch-all (:path*) also
    // passed encoded dot segments (/n8n/%2e%2e/rest/...), which n8n resolves to its own editor API.
    return [{ source: '/n8n/api/v1/:group([a-z_]{1,40})', destination: `${N8N_URL}/webhook/api/v1/:group` }];
  },
  // Security headers. Health data must never be cached by the browser or a proxy, reset links must not leak through the
  // Referer header, and the app is never framed. Microphone (voice input) and location (nearest facility) are allowed
  // for this site only. HSTS is added by Caddy in front of the HTTPS deployment.
  async headers() {
    const dev = process.env.NODE_ENV !== 'production';
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${dev ? ' ws: http://localhost:*' : ''}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=(self), payment=(), usb=(), interest-cohort=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
      { source: '/n8n/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'Pragma', value: 'no-cache' }] },
    ];
  },
};

export default nextConfig;
