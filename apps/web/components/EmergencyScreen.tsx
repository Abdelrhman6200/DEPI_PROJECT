'use client';

import { AlertOctagon, ArrowLeft, ArrowRight, Candy, Phone, Timer } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import type { TKey } from '@/lib/i18n';

/**
 * Offline-safe emergency screen. It is pure static content from the bundled i18n dictionary:
 * it never calls the API, so it keeps working with no network.
 */
export function EmergencyScreen({ onClose }: { onClose?: () => void }) {
  const { t, dir } = useLocale();
  const hypo: TKey[] = ['em.hypo1', 'em.hypo2', 'em.hypo3', 'em.hypo4', 'em.hypo5'];
  const signs: TKey[] = ['em.sign1', 'em.sign2', 'em.sign3', 'em.sign4', 'em.sign5', 'em.sign6'];
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="min-h-full bg-bg">
      <div className="bg-danger-solid px-4 pt-6 pb-8 text-white sm:px-6">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertOctagon className="size-7" aria-hidden />
              <h1 className="text-2xl font-bold">{t('em.title')}</h1>
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-white/15 px-3 py-2 text-base font-semibold hover:bg-white/25"
              >
                <Back className="size-5" aria-hidden />
                {t('em.back')}
              </button>
            )}
          </div>
          <p className="mt-1 text-base text-white/90">{t('em.subtitle')}</p>
          {/* first focus when this screen opens over the app: calling for help comes before going back */}
          <a
            href="tel:123"
            data-autofocus
            className="mt-5 flex min-h-20 items-center justify-center gap-3 rounded-2xl bg-white px-5 py-5 text-2xl font-bold text-[#991b1b] shadow-lg active:scale-[0.99]"
          >
            <Phone className="size-7" aria-hidden />
            {t('em.call')}
          </a>
          <p className="mt-3 text-base leading-7 text-white/95">{t('em.callHint')}</p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-6">
        <section className="rounded-2xl border-2 border-warn/50 bg-warn-soft p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-warn-fg">
            <Candy className="size-5" />
            {t('em.hypoTitle')}
          </h2>
          <ol className="space-y-3">
            {hypo.map((k, i) => (
              <li key={k} className="flex gap-3 text-base leading-7 text-fg">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-warn text-sm font-bold text-white">
                  {i === 2 ? <Timer className="size-4" /> : i + 1}
                </span>
                <span>{t(k)}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-2xl border-2 border-danger/40 bg-danger-soft p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-bold text-danger-fg">
            <AlertOctagon className="size-5" />
            {t('em.signsTitle')}
          </h2>
          <ul className="space-y-2.5">
            {signs.map((k) => (
              <li key={k} className="flex gap-2.5 text-base leading-7 text-fg">
                <span className="mt-2.5 size-2 shrink-0 rounded-full bg-danger-solid" />
                {t(k)}
              </li>
            ))}
          </ul>
          <a
            href="tel:123"
            className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-danger-solid px-4 py-3 text-lg font-bold text-white"
          >
            <Phone className="size-5" aria-hidden />
            {t('em.call')}
          </a>
        </section>
      </div>
    </div>
  );
}
