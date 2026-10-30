import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';
import { PREFS_BOOT_SCRIPT } from '@/lib/prefs';

// The build id in the worker's address makes every deploy install a fresh worker with its own cache version.
const SW_URL = `/sw.js?v=${encodeURIComponent(process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev')}`;
const SW_SCRIPT = `if('serviceWorker' in navigator){var r=function(){navigator.serviceWorker.register(${JSON.stringify(SW_URL)},{scope:'/'}).catch(function(){})};document.readyState==='complete'?r():window.addEventListener('load',r)}`;

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MediCare · ميديكير',
  description: 'Arabic-first care for diabetes and the specialist clinics, on one patient record',
  applicationName: 'MediCare',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: 'MediCare', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0f766e' },
    { media: '(prefers-color-scheme: dark)', color: '#111312' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={`${arabic.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        {/* Apply saved theme, text size and language before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: PREFS_BOOT_SCRIPT }} />
        {/* Offline support (emergency page, app shell). Production only: in development it would fight hot reloading. */}
        {process.env.NODE_ENV === 'production' && <script dangerouslySetInnerHTML={{ __html: SW_SCRIPT }} />}
      </head>
      <body className="min-h-dvh font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
