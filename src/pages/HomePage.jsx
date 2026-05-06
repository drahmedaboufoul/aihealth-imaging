import React from 'react';
import Shell from '../components/Shell';
import { Activity, FileImage, ScanLine, Box, ExternalLink } from 'lucide-react';

export default function HomePage() {
  return (
    <Shell>
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-6">
          <Activity size={20} className="text-accent" />
          <h1 className="text-[22px] font-semibold tracking-tight">aiHealth Imaging</h1>
          <span className="text-[10px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded bg-panel2 text-muted">Phase 1</span>
        </div>

        <p className="text-[13px] text-muted leading-relaxed mb-8">
          Standalone PACS + viewer extracted from the aiHealth EMR. This page is intentionally bare —
          the product is the viewer, not a marketing site. Real surfaces below.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
          <Surface
            icon={ScanLine}
            title="DICOM Viewer"
            desc="2D / multi-frame DICOM"
            path="/viewer/dicom"
          />
          <Surface
            icon={Box}
            title="CBCT Viewer"
            desc="Cone-beam volume rendering"
            path="/viewer/cbct"
          />
          <Surface
            icon={FileImage}
            title="IOS Viewer"
            desc="Intra-oral 3D scan"
            path="/viewer/ios"
          />
        </div>

        <div className="rounded border border-border bg-panel p-4 text-[12px] leading-relaxed">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted mb-2">Status</div>
          Scaffold deployed. URL contract matches the EMR's existing
          {' '}<code className="font-mono text-accent">window.open</code>{' '} targets so the EMR can
          point at this app via a feature flag. Renderers will move over from the EMR in phase 2.
          See <a href="https://github.com/drahmedaboufoul/aihealth-medical-center-billing/blob/working-branch/handoff/IMAGING_SPLIT.md" className="text-accent inline-flex items-center gap-1">extraction contract <ExternalLink size={10} /></a>.
        </div>
      </div>
    </Shell>
  );
}

function Surface({ icon: Icon, title, desc, path }) {
  return (
    <a
      href={`${path}?id=demo`}
      className="block rounded border border-border bg-panel hover:border-accent/60 transition-colors p-4"
    >
      <Icon size={18} className="text-accent mb-2" />
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11px] text-muted mt-0.5">{desc}</div>
      <div className="text-[10px] font-mono text-muted mt-3">{path}</div>
    </a>
  );
}
