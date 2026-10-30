'use client';

import {
  Fragment,
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

// 16 px text in inputs also stops iOS from zooming into the field.
const control =
  'w-full rounded-xl border border-line-strong bg-surface px-3 text-base text-fg placeholder:text-fg-subtle ' +
  'focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/25 disabled:opacity-60 ' +
  'aria-[invalid=true]:border-danger';

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = hintId ?? errorId;
  // The hint or error is read out with the control (aria-describedby), not only when someone reads the whole form.
  let control = children;
  if (describedBy && isValidElement(children) && children.type !== Fragment) {
    const el = children as ReactElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' }>;
    const own = el.props['aria-describedby'];
    control = cloneElement(el, {
      'aria-describedby': own ? `${own} ${describedBy}` : describedBy,
      ...(error ? { 'aria-invalid': el.props['aria-invalid'] ?? true } : {}),
    });
  }
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="block text-sm font-medium text-fg">{label}</span>
      {control}
      {hint && !error && (
        <span id={hintId} className="block text-sm text-fg-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} role="alert" className="block text-sm font-medium text-danger">
          {error}
        </span>
      )}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  // number/date fields always use Western digits so values match charts, devices and lab reports
  const lang = rest.lang ?? (rest.type === 'number' || rest.type === 'date' || rest.type === 'datetime-local' || rest.type === 'tel' ? 'en' : undefined);
  return <input className={cn(control, 'h-11', className)} lang={lang} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, 'h-11 pe-8', className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, 'min-h-24 py-2.5 leading-7', className)} {...rest} />;
}

/** Option chips (single or multi select). Each chip is a 44 px tap target. */
export function Chips<T extends string>({
  options,
  value,
  onToggle,
  className,
  size = 'md',
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T[];
  onToggle: (v: T) => void;
  className?: string;
  size?: 'sm' | 'md';
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap gap-2', className)}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(o.value)}
            className={cn(
              'rounded-full border font-medium transition-colors',
              size === 'md' ? 'min-h-11 px-4 text-base' : 'min-h-9 px-3 text-sm',
              on ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Large radio-like option buttons (one question per screen, sign-up, settings). */
export function OptionButtons<T extends string>({
  options,
  value,
  onChange,
  className,
  columns = 1,
  name,
  disabled,
}: {
  options: { value: T; label: ReactNode; hint?: ReactNode; icon?: ReactNode }[];
  value: T | null;
  onChange: (v: T) => void;
  className?: string;
  columns?: 1 | 2 | 3;
  name?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={name} className={cn('grid gap-2', columns === 2 && 'grid-cols-2', columns === 3 && 'grid-cols-3', className)}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            id={`${id}-${o.value}`}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex min-h-14 items-center gap-3 rounded-2xl border-2 px-4 py-3 text-start text-base font-medium transition-colors disabled:opacity-60',
              on ? 'border-primary bg-primary-soft text-fg' : 'border-line bg-surface text-fg hover:border-line-strong',
            )}
          >
            {o.icon && <span className={cn('shrink-0', on ? 'text-primary-strong' : 'text-fg-muted')}>{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block">{o.label}</span>
              {o.hint && <span className="mt-0.5 block text-sm font-normal text-fg-muted">{o.hint}</span>}
            </span>
            <span
              aria-hidden
              className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-primary bg-primary' : 'border-line-strong')}
            >
              {on && <span className="size-2 rounded-full bg-primary-fg" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Checkbox row with a bold title and plain-language explanation (consents, confirmations). */
export function CheckRow({
  checked,
  onChange,
  title,
  body,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: ReactNode;
  body?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-2xl border-2 p-4 transition-colors',
        checked ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:border-line-strong',
        className,
      )}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-5 shrink-0 accent-[var(--primary)]" />
      <span className="min-w-0">
        <span className="block text-base font-semibold text-fg">{title}</span>
        {body && <span className="mt-1 block text-sm leading-6 text-fg-muted">{body}</span>}
      </span>
    </label>
  );
}
