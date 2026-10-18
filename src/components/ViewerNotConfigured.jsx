/*
 * Shown instead of a white page when the deployment is missing its client
 * configuration (see lib/config.js). Deliberately generic: no variable
 * names, URLs or ids on a page an outside recipient may open; the missing
 * names go to the console for the operator.
 */
import { Settings } from 'lucide-react';

export default function ViewerNotConfigured() {
  return (
    <div className="h-screen w-screen bg-background-primary text-labels-primary flex items-center justify-center p-6">
      <div role="alert" className="max-w-md w-full text-center flex flex-col items-center gap-3">
        <Settings size={28} className="text-labels-tertiary" aria-hidden="true" />
        <h1 className="text-sm font-semibold">Viewer not configured</h1>
        <p className="text-xs text-labels-secondary leading-relaxed">
          This imaging viewer has not been set up on this deployment yet, so no
          images can be shown. Please contact the clinic that sent you here.
        </p>
      </div>
    </div>
  );
}
