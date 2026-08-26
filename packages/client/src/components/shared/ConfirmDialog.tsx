import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** If set, the user must type this exact string before the confirm button enables. Use for destructive resets. */
  typeToConfirm?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  typeToConfirm,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const canConfirm = !busy && (!typeToConfirm || typed === typeToConfirm);
  const accent = danger ? '#FF2D55' : '#7C3AED';

  useEffect(() => {
    if (!open) {
      setTyped('');
      setBusy(false);
      return;
    }
    const t = setTimeout(() => {
      if (typeToConfirm) inputRef.current?.focus();
      else confirmRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [open, typeToConfirm]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) onCancel();
      } else if (e.key === 'Enter' && canConfirm) {
        e.preventDefault();
        void handleConfirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, canConfirm, onCancel]);

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 440,
          background: '#0A0E1A',
          border: `1px solid ${accent}33`,
          boxShadow: `0 0 40px ${accent}18`,
          padding: '1.5rem 1.5rem 1.25rem',
        }}
      >
        <div
          className="text-[10px] font-mono tracking-[0.2em] uppercase mb-2"
          style={{ color: accent }}
        >
          {danger ? 'Danger zone' : 'Confirm'}
        </div>
        <h3 className="text-lg font-black mb-2" style={{ color: '#E8EFFF', lineHeight: 1.2 }}>
          {title}
        </h3>
        <div className="text-sm leading-relaxed mb-4" style={{ color: '#B0BCDB' }}>
          {body}
        </div>

        {typeToConfirm && (
          <div className="mb-4">
            <label
              className="text-[10px] font-mono tracking-wider uppercase block mb-1.5"
              style={{ color: '#7A8BAD' }}
            >
              Type <span style={{ color: accent, fontWeight: 700 }}>{typeToConfirm}</span> to
              confirm
            </label>
            <input
              ref={inputRef}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full text-sm font-mono"
              style={{
                background: '#0D1221',
                border: `1px solid ${accent}33`,
                color: '#E8EFFF',
                padding: '0.5rem 0.75rem',
                outline: 'none',
                caretColor: accent,
              }}
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-[11px] font-mono tracking-wider uppercase px-3 py-1.5"
            style={{
              background: 'transparent',
              color: '#7A8BAD',
              border: '1px solid #1A2440',
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm}
            className="text-[11px] font-mono tracking-wider uppercase px-3 py-1.5 font-bold"
            style={{
              background: canConfirm ? accent : '#1A2440',
              color: canConfirm ? '#fff' : '#3D4F6E',
              border: 'none',
              cursor: canConfirm ? 'pointer' : 'not-allowed',
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Reusable trash icon ─────────────────────────────────────────────────────

export function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
