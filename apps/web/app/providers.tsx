'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { LocaleProvider } from '@/lib/locale';
import { InstallPromptProvider, PrefsProvider } from '@/lib/prefs';
import { ToastProvider } from '@/components/Toast';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <PrefsProvider>
      <InstallPromptProvider>
        <LocaleProvider>
          <AuthProvider>
            <ToastProvider>{children}</ToastProvider>
          </AuthProvider>
        </LocaleProvider>
      </InstallPromptProvider>
    </PrefsProvider>
  );
}
