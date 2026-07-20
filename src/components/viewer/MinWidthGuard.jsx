/*
 * MinWidthGuard — desktop-first viewers need a minimum viewport width
 * (audit #14). Below 1024px (Tailwind `lg`) the viewer chrome (tool strip
 * + context panel + 2×2 MPR grid) cannot stay usable, so we show a clear
 * guard message instead of a broken layout. Pure CSS (media query via the
 * lg:hidden utility) — no resize listeners.
 */
import { MonitorX } from 'lucide-react';

export default function MinWidthGuard() {
  return (
    <div className="fixed inset-0 z-toast lg:hidden flex items-center justify-center bg-background-primary px-8">
      <div className="max-w-sm text-center">
        <MonitorX size={32} className="mx-auto text-labels-tertiary mb-4" />
        <h1 className="text-base font-semibold text-labels-primary mb-2">
          This viewer needs a wider screen
        </h1>
        <p className="text-sm text-labels-secondary leading-relaxed">
          The imaging viewer is designed for desktop use at 1024px width or
          more. Open it on a larger display, or widen this window to continue.
        </p>
      </div>
    </div>
  );
}
