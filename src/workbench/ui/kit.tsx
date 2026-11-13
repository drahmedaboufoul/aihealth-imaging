/*
 * Small presentational pieces shared by the workbench panels. Styling
 * follows the existing IOS viewer: white rounded panels, gray text, a
 * blue-600 active state.
 */
import { useState, type ReactNode } from 'react';
import { useWorkbench, SLOTS, type Slot } from './store';

export function Section({ title, children, right, testId }: { title: string; children: ReactNode; right?: ReactNode; testId?: string }) {
  return (
    <section className="mb-4" data-testid={testId}>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
const VARIANTS: Record<BtnVariant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700',
  secondary: 'bg-gray-100 text-gray-800 hover:bg-gray-200 border border-gray-200',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  ghost: 'text-gray-600 hover:bg-gray-100',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700',
};

export function Btn({ children, onClick, variant = 'secondary', disabled, testId, title, className = '' }: {
  children: ReactNode; onClick?: () => void; variant?: BtnVariant; disabled?: boolean; testId?: string; title?: string; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} data-testid={testId}
      className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-gray-700 py-0.5">
      <span title={hint}>{label}</span>
      {children}
    </label>
  );
}

export function NumInput({ value, onChange, step = 0.01, min, max, testId, suffix, width = 'w-20' }: {
  value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; testId?: string; suffix?: string; width?: string;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <input type="number" step={step} min={min} max={max} data-testid={testId}
        value={focused ? text : String(value)}
        onFocus={() => { setFocused(true); setText(String(value)); }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) onChange(v);
        }}
        className={`${width} rounded border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-800 tabular-nums`} />
      {suffix && <span className="text-[11px] text-gray-500">{suffix}</span>}
    </span>
  );
}

export function SlotSelect({ value, onChange, testId, exclude }: { value: Slot; onChange: (s: Slot) => void; testId?: string; exclude?: Slot }) {
  const scans = useWorkbench((s) => s.scans);
  const options = SLOTS.filter((s) => scans[s]?.status === 'ready');
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Slot)} data-testid={testId}
      className="rounded border border-gray-200 bg-white px-1.5 py-1 text-xs text-gray-800">
      {options.map((s) => <option key={s} value={s} disabled={s === exclude}>{`Scan ${s}`}{scans[s]?.role !== 'unknown' ? ` (${scans[s]?.role})` : ''}</option>)}
      {!options.includes(value) && <option value={value}>{`Scan ${value} (not loaded)`}</option>}
    </select>
  );
}

export function StatusBadge({ status, accepted, testId }: { status: 'none' | 'draft' | 'accepted'; accepted?: { by: string; at: string }; testId?: string }) {
  if (status === 'none') return null;
  if (status === 'draft') {
    return (
      <span data-testid={testId} className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
        Draft · not accepted
      </span>
    );
  }
  return (
    <span data-testid={testId} title={accepted ? `Accepted ${new Date(accepted.at).toLocaleString('en-GB')}` : undefined}
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
      Accepted{accepted ? ` · ${accepted.by}` : ''}
    </span>
  );
}

export function AcceptBox({ status, onAccept, what, testPrefix }: { status: 'none' | 'draft' | 'accepted'; onAccept: (name: string) => void; what: string; testPrefix: string }) {
  const reviewer = useWorkbench((s) => s.reviewerName);
  const [name, setName] = useState(reviewer);
  if (status !== 'draft') return null;
  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
      <p className="text-[11px] text-amber-900 mb-1.5">
        This {what} was computed automatically. It stays a <b>draft</b> until a named person reviews and accepts it.
      </p>
      <div className="flex items-center gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Reviewer name" data-testid={`${testPrefix}-reviewer`}
          className="flex-1 min-w-0 rounded border border-amber-300 bg-white px-1.5 py-1 text-xs" />
        <Btn variant="success" onClick={() => onAccept(name)} disabled={name.trim().length < 2} testId={`${testPrefix}-accept`}>Accept</Btn>
      </div>
    </div>
  );
}

export function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between text-xs py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono tabular-nums text-gray-800" data-testid={testId}>{value}</span>
    </div>
  );
}

export function mm(v: number | undefined, digits = 3): string {
  return v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 && digits === 3 ? '+' : ''}${v.toFixed(digits)} mm`;
}

export function pct(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}
