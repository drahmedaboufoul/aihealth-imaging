import React from 'react';
import { Link } from 'react-router-dom';
import Shell from '../components/Shell';
import { Activity, FileImage, ScanLine, Box, ExternalLink, Sparkles } from 'lucide-react';

export default function HomePage() {
  return (
    <Shell>
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-6">
          <Activity size={20} className="text-accent" />
          <h1 className="text-[22px] font-semibold tracking-tight">aiHealth Imaging</h1>
          <span className="text-xs uppercase tracking-[0.1em] px-1.5 py-0.5 rounded bg-panel2 text-muted">Phase 2</span>
        </div>

        <p className="text-sm text-muted leading-relaxed mb-8">
          Standalone PACS + viewer extracted from the aiHealth EMR. Click any tile to open the
          underlying viewer. The IOS viewer is fully wired with a real Three.js renderer — try
          the demo to see it render a sample mesh end-to-end.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
          <Surface
            icon={Box}
            title="IOS Viewer"
            desc="Three.js · STL/PLY/OBJ"
            badge="Live"
            badgeTone="success"
            primaryAction={{ label: 'Open demo', to: '/viewer/ios?demo=1' }}
            secondaryNote="Or pass ?id=<file_id> from the EMR"
          />
          <Surface
            icon={ScanLine}
            title="DICOM Viewer"
            desc="2D / multi-frame DICOM"
            badge="Live"
            badgeTone="success"
            primaryAction={{ label: 'Open viewer', to: '/viewer/dicom' }}
            secondaryNote="Cornerstone3D 4 · stack scroll + W/L"
          />
          <Surface
            icon={Sparkles}
            title="CBCT Viewer"
            desc="Cone-beam volume rendering"
            badge="Live"
            badgeTone="success"
            primaryAction={{ label: 'Open viewer', to: '/viewer/cbct' }}
            secondaryNote="MPR + 3D · implant & nerve planning"
          />
        </div>

        <div className="rounded border border-border bg-panel p-4 text-xs leading-relaxed">
          <div className="text-xs uppercase tracking-[0.08em] text-muted mb-2">Status</div>
          All three viewers are live: IOS (Three.js mesh renderer), DICOM (2D stack),
          and CBCT (MPR + 3D volume on Cornerstone3D 4). The URL contract for all three
          matches the EMR's existing window.open targets so the EMR can flip a feature
          flag without changing call sites. Architecture notes in
          {' '}<a href="https://github.com/drahmedaboufoul/aihealth-imaging/blob/main/handoff/INFRASTRUCTURE.md" className="text-accent inline-flex items-center gap-1">INFRASTRUCTURE.md <ExternalLink size={10} /></a>.
        </div>
      </div>
    </Shell>
  );
}

function Surface({ icon: Icon, title, desc, badge, badgeTone, primaryAction, secondaryNote }) {
  const badgeCls = {
    success: 'bg-status-success-soft text-status-success',
    warning: 'bg-status-warning-soft text-status-warning',
    info:    'bg-accent-soft text-accent',
  }[badgeTone] || 'bg-fills-f1 text-labels-tertiary';

  return (
    <div className="rounded border border-border bg-panel p-4 flex flex-col">
      <div className="flex items-start justify-between mb-2">
        <Icon size={18} className="text-accent" />
        <span
          className={`text-xs uppercase tracking-[0.1em] px-1.5 py-0.5 rounded font-medium ${badgeCls}`}
        >
          {badge}
        </span>
      </div>
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted mt-0.5">{desc}</div>
      <Link
        to={primaryAction.to}
        className="mt-3 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-accent text-white hover:bg-accent-hover"
      >
        {primaryAction.label}
      </Link>
      <div className="text-xs font-mono text-muted mt-2">{secondaryNote}</div>
    </div>
  );
}
