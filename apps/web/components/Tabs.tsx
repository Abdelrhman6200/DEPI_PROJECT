'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

/** Ids that tie a tab to its panel. Pass the same `idBase` to <Tabs> and to the panel. */
export function tabIds(idBase: string, id: string) {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return { tab: `${idBase}-tab-${safe}`, panel: `${idBase}-panel-${safe}` };
}

/** Props for the element that shows the selected tab's content. */
export function tabPanelProps(idBase: string, id: string) {
  const ids = tabIds(idBase, id);
  return { id: ids.panel, role: 'tabpanel' as const, 'aria-labelledby': ids.tab, tabIndex: 0 };
}

/**
 * WAI-ARIA tabs: one tab in the Tab order (roving tabindex), arrow keys move between tabs (mirrored in
 * right-to-left layouts), Home/End jump to the first/last. Selection follows focus.
 * With `idBase`, each tab names the panel it controls (render the panel with tabPanelProps).
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  variant = 'underline',
  idBase,
  label,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  variant?: 'underline' | 'pills';
  idBase?: string;
  label?: string;
}) {
  const autoId = useId();
  const base = idBase ?? `tabs-${autoId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = tabs.findIndex((x) => x.id === value);
    if (idx < 0) return;
    const rtl = listRef.current ? getComputedStyle(listRef.current).direction === 'rtl' : false;
    let next = -1;
    if (e.key === 'ArrowRight') next = rtl ? idx - 1 : idx + 1;
    else if (e.key === 'ArrowLeft') next = rtl ? idx + 1 : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    next = (next + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    // focus the newly selected tab once it has re-rendered
    requestAnimationFrame(() => document.getElementById(tabIds(base, tabs[next].id).tab)?.focus());
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        '-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible',
        variant === 'underline' && 'border-b border-line',
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        const ids = tabIds(base, tab.id);
        return (
          <button
            key={tab.id}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={idBase ? ids.panel : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors',
              variant === 'underline' &&
                cn(
                  '-mb-px min-h-11 border-b-2 px-3 py-2.5',
                  active ? 'border-primary text-primary-strong' : 'border-transparent text-fg-muted hover:text-fg',
                ),
              variant === 'pills' &&
                cn(
                  'min-h-10 rounded-full border px-3.5 py-1.5',
                  active
                    ? 'border-primary bg-primary text-primary-fg'
                    : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg',
                ),
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs leading-4',
                  active && variant === 'pills' ? 'bg-white/20' : 'bg-surface-2 text-fg-muted',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control for small option sets (e.g. 7/14/30/90 days). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
  size = 'md',
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-xl border border-line bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[10px] font-medium transition-colors',
            size === 'sm' && 'px-3 py-1 text-sm',
            size === 'md' && 'min-h-9 px-3 py-1.5 text-sm',
            size === 'lg' && 'min-h-11 px-3 py-2 text-base',
            o.value === value ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
