'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Stacking level of an element: the z-index of the nearest ancestor (or itself) that sets one. */
function stackLevel(el: HTMLElement): number {
  for (let x: HTMLElement | null = el; x; x = x.parentElement) {
    const z = getComputedStyle(x).zIndex;
    if (z !== 'auto') return Number(z) || 0;
  }
  return 0;
}

/** The modal the person sees on top: highest stacking level, and the later one in the page when equal. */
function topModal(): HTMLElement | null {
  let top: HTMLElement | null = null;
  let level = -Infinity;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))) {
    const l = stackLevel(el);
    if (l >= level) {
      top = el;
      level = l;
    }
  }
  return top;
}

/** Number of open full-screen overlays; the page scroll is locked while any is open. */
let locks = 0;
let savedOverflow = '';

/**
 * Modal behaviour for full-screen overlays that are not built on <Dialog> (emergency screens, onboarding):
 * moves focus inside, keeps Tab inside, locks the page scroll and gives focus back on close.
 * `onEscape` is only passed for overlays that may be dismissed: an emergency screen ignores Escape.
 */
export function useModal(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (locks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    const focusFirst = () => {
      const el = ref.current;
      if (!el) return;
      if (el.contains(document.activeElement)) return;
      const auto = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (auto ?? el).focus();
    };
    // after paint, so content rendered in the same commit is focusable
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      // only the top-most overlay reacts (a dialog opened above it handles its own keys)
      const top = topModal();
      if (top && top !== el && !el.contains(top)) return;
      if (e.key === 'Escape' && escRef.current) {
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!el.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      if (--locks === 0) document.body.style.overflow = savedOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus?.();
    };
  }, [active, ref]);
}
