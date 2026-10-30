'use client';

import { useState, type ReactNode } from 'react';
import { useLocale } from '@/lib/locale';
import { Dialog } from './Dialog';
import { Button } from './Button';

/**
 * "Are you sure?" for actions that are hard to undo (cancel, retire, deactivate, disconnect...).
 * `onConfirm` may be async: the confirm button shows a spinner until it settles, then the dialog closes.
 * A rejected promise keeps the dialog open (the caller shows the error).
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = true,
  children,
  confirmDisabled,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  /** Extra content under the body (a preview, a required checkbox). */
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      /* the caller reports the error; keep the dialog open to try again */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size="lg" loading={busy} disabled={confirmDisabled} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="text-base leading-7 text-fg">{body}</div>}
      {children && <div className={body ? 'mt-3' : undefined}>{children}</div>}
    </Dialog>
  );
}

/**
 * Hook form for list rows: `ask(item)` opens the dialog for that item, `dialogProps` spreads into <ConfirmDialog>.
 * Keeps the item while the dialog closes so the text does not change during the closing frame.
 */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  return {
    target,
    ask: (item: T) => setTarget(item),
    close: () => setTarget(null),
    open: target !== null,
  };
}
