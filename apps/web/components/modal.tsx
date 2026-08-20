'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Minimal centered modal rendered into document.body. Closes on overlay click
 * or Escape. Intentionally dependency-free (no Radix) to match the app's
 * lightweight component style.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/30 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>}
        <div className={title ? 'mt-3' : ''}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
