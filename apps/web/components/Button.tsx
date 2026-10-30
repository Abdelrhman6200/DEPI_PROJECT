'use client';

import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'soft';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-strong border-transparent',
  secondary: 'bg-surface-2 text-fg hover:bg-line border-transparent',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg border-transparent',
  danger: 'bg-danger-solid text-white hover:bg-danger-solid-hover border-transparent',
  outline: 'bg-surface text-fg border-line-strong hover:bg-surface-2',
  soft: 'bg-primary-soft text-primary-strong hover:bg-primary/15 border-transparent',
};

/** md and up meet the 44 px minimum tap target; xs/sm are for dense staff screens. */
const SIZES: Record<ButtonSize, string> = {
  xs: 'h-8 px-2.5 text-xs gap-1 rounded-lg',
  sm: 'h-9 px-3 text-sm gap-1.5 rounded-lg',
  md: 'min-h-11 px-4 text-sm gap-2 rounded-xl',
  lg: 'min-h-12 px-5 text-base gap-2 rounded-xl',
  xl: 'min-h-14 px-6 text-lg gap-2.5 rounded-2xl',
};

/**
 * Drops a size default when the caller sets the same kind of utility (padding, radius, height). Both classes would
 * otherwise be present and the stylesheet order, not the caller, would decide: an icon-only button written as
 * "size-12 px-0" kept its large side padding and squashed the icon.
 */
function sizeClass(size: ButtonSize, className?: string) {
  if (!className) return SIZES[size];
  const extra = className.split(/\s+/);
  const has = (re: RegExp) => extra.some((c) => re.test(c));
  return SIZES[size]
    .split(' ')
    .filter((c) => !((/^px-/.test(c) && has(/^px?-/)) || (/^rounded-/.test(c) && has(/^rounded-/)) || (/^(h|min-h)-/.test(c) && has(/^(h|min-h|size)-/))))
    .join(' ');
}

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string) {
  return cn(
    'inline-flex select-none items-center justify-center border font-semibold transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    sizeClass(size, className),
    className,
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    icon?: ReactNode;
  }
>(function Button({ variant = 'primary', size = 'md', loading = false, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {icon}
      {children}
    </Link>
  );
}
