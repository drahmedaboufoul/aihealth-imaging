/*
 * controls — shared, token-styled viewer controls (audit W6, findings
 * #15/#17). Consumed by both the CBCT viewer (tool strip + context panel)
 * and the DICOM viewer (right rail) so the two siblings render identical
 * control contracts.
 *
 * Every interactive element here ships the full state matrix:
 *   default / hover / active / disabled / focus-visible
 * Focus-visible comes from the global ring in index.css (2px accent).
 */
import { Slider } from '../ui/slider';

// Active-state fill per semantic tone (audit #18): accent = primary
// action, success = nerve, ai = purple AI features, danger = destructive.
const TONE_ACTIVE = {
  accent:  'bg-accent text-white',
  success: 'bg-status-success text-white',
  ai:      'bg-status-ai text-white',
  danger:  'bg-status-danger text-white',
};

/**
 * ToolButton — 32×32 icon button for viewer tool strips.
 * States: default (label-secondary icon on transparent), hover (fills-f2),
 * active (tone fill), disabled (quaternary, no hover), focus-visible
 * (global accent ring). `danger` shifts the hover state to danger for
 * destructive actions (e.g. clear measurements).
 */
export function ToolButton({ active = false, onClick, icon: Icon, label, danger = false, tone = 'accent', disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex items-center justify-center w-8 h-8 rounded-lg transition-[background-color,color] duration-150 ${
        active
          ? TONE_ACTIVE[tone] || TONE_ACTIVE.accent
          : danger
          ? 'text-labels-secondary hover:bg-status-danger hover:text-white'
          : 'text-labels-secondary hover:bg-fills-f2 hover:text-labels-primary'
      } disabled:text-labels-quaternary disabled:hover:bg-transparent disabled:hover:text-labels-quaternary`}
    >
      <Icon size={15} />
    </button>
  );
}

/**
 * PanelButton — full-width text(+icon) button used inside context panels.
 * Same state matrix as ToolButton; `active` uses the tone fill.
 */
export function PanelButton({ active = false, tone = 'accent', danger = false, className = '', children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-[background-color,color] duration-150 disabled:opacity-40 disabled:pointer-events-none ${
        active
          ? TONE_ACTIVE[tone] || TONE_ACTIVE.accent
          : danger
          ? 'bg-fills-f1 text-labels-primary hover:bg-status-danger hover:text-white'
          : 'bg-fills-f1 text-labels-primary hover:bg-fills-f2'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * ViewerSlider — labeled slider row built on the shared ui/slider (Radix).
 * Replaces the raw `<input type="range">` controls (which had per-slider
 * accent colors and no focus/hover contract). Label 12px, value readout
 * tabular-nums mono.
 */
export function ViewerSlider({ label, icon: Icon, value, min, max, step = 1, unit = '', onChange, disabled = false, title }) {
  return (
    <div title={title}>
      <div className="flex items-center justify-between text-xs text-labels-secondary mb-1.5">
        <span className="flex items-center gap-1">
          {Icon && <Icon size={12} />}
          {label}
        </span>
        <span className="font-mono tabular-nums text-labels-primary">
          {value}{unit}
        </span>
      </div>
      <Slider
        value={[Number(value)]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

/**
 * SectionLabel — 12px uppercase quiet label separating panel sections
 * (replaces the 9px section headers from the old rail).
 */
export function SectionLabel({ children, className = '' }) {
  return (
    <div className={`text-xs uppercase tracking-wider text-labels-tertiary ${className}`}>
      {children}
    </div>
  );
}

/** StripDivider — 1px separator between tool-strip groups. */
export function StripDivider() {
  return <div className="w-6 my-1 border-t border-separator-s1" aria-hidden="true" />;
}
