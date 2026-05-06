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
          <span className="text-[10px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded bg-panel2 text-muted">Phase 2</span>
        </div>

        <p className="text-[13px] text-muted leading-relaxed mb-8">
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
            badge="Stub"
            badgeTone="warning"
            primaryAction={{ label: 'View stub', to: '/viewer/dicom' }}
            secondaryNote="Cornerstone3D moves over in next milestone"
          />
          <Surface
            icon={Sparkles}
            title="CBCT Viewer"
            desc="Cone-beam volume rendering"
            badge="Stub"
            badgeTone="warning"
            primaryAction={{ label: 'View stub', to: '/viewer/cbct' }}
            secondaryNote="OHIF Viewer integration coming"
          />
        </div>

        <div className="rounded border border-border bg-panel p-4 text-[12px] leading-relaxed">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted mb-2">Status</div>
          IOS viewer is live with the real renderer ported from the EMR. DICOM and CBCT
          viewers are still stubs — the migration plan in
          {' '}<a href="https://github.com/drahmedaboufoul/aihealth-imaging/blob/main/handoff/INFRASTRUCTURE.md" className="text-accent inline-flex items-center gap-1">INFRASTRUCTURE.md <ExternalLink size={10} /></a>{' '}
          adopts Cornerstone3D + OHIF for those rather than carrying the EMR's deprecated
          Cornerstone-Tools v3 over. The URL contract for all three matches the EMR's
          existing window.open targets so the EMR can flip a feature flag without changing call sites.
        </div>
      </div>
    </Shell>
  );
}

function Surface({ icon: Icon, title, desc, badge, badgeTone, primaryAction, secondaryNote }) {
  const badgeBg = {
    success: '#0E3A2A',
    warning: '#3F2D0A',
    info:    '#10283F',
  }[badgeTone] || '#1F2025';
  const badgeFg = {
    success: '#5EE3A8',
    warning: '#F2C56B',
    info:    '#80BFFF',
  }[badgeTone] || '#888A92';

  return (
    <div className="rounded border border-border bg-panel p-4 flex flex-col">
      <div className="flex items-start justify-between mb-2">
        <Icon size={18} className="text-accent" />
        <span
          className="text-[9px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded font-medium"
          style={{ background: badgeBg, color: badgeFg }}
        >
          {badge}
        </span>
      </div>
      <div className="text-[13px] font-medium">{title}</div>
      <div className="text-[11px] text-muted mt-0.5">{desc}</div>
      <Link
        to={primaryAction.to}
        className="mt-3 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium bg-accent text-bg hover:bg-accent/90"
        style={{ backgroundImage: 'none' }}
      >
        {primaryAction.label}
      </Link>
      <div className="text-[10px] font-mono text-muted mt-2">{secondaryNote}</div>
    </div>
  );
}
