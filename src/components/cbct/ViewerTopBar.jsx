/*
 * ViewerTopBar — CBCT viewer header: Close, title + read-only badge,
 * patient banner, view-mode tabs, live co-viewing controls, share.
 *
 * Extracted from CBCTViewerPage.jsx during the A0 monolith split.
 *
 * W2 (audit finding #1): renders the patient identity banner
 * (name · MRN · DOB · study date) so the viewer never shows PHI without
 * context. W3 (finding #5): the Go-live tooltip now describes what
 * actually syncs (view settings), not "navigation".
 * W8 (finding #25): the "Cornerstone3D v4" vendor watermark is gone.
 * W9 (finding #21): when the viewer runs inside a share iframe
 * (`embedded`), its own Close + branding block is suppressed — the outer
 * SharedViewerPage already provides the session chrome.
 */
import { ArrowLeft, Box, Radio, Users, Share2, User } from 'lucide-react';
import { VIEW_MODES } from './cbctViewModes';

export default function ViewerTopBar({
  readOnly,
  embedded = false,
  viewMode,
  onSwitchMode,
  stage,
  studyId,
  effectiveStudyId,
  goLive,
  onToggleGoLive,
  participants,
  operatorPresent,
  operatorName,
  onShare,
  patientMeta,
  onClose,
}) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-separator-s1">
      <div className="flex items-center gap-3 min-w-0">
        {!embedded && (
          <>
            <button
              onClick={onClose}
              className="text-sm px-2 py-1 rounded-lg hover:bg-fills-f1 flex items-center gap-1.5 transition-[background-color] duration-150"
            >
              <ArrowLeft size={14} /> Close
            </button>
            <div className="text-sm font-semibold tracking-wide flex items-center gap-2">
              <Box size={14} className="text-accent" />
              CBCT Viewer
              {readOnly && (
                <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-soft text-accent">
                  Read-only
                </span>
              )}
            </div>
          </>
        )}
        {/* Patient identity banner — wrong-patient guard. Data comes from
            imaging_studies → customers (authed) or the share payload.
            Rendered even in embedded mode: patient context is the point
            of the share. */}
        {patientMeta && (patientMeta.patientName || patientMeta.studyDate) && (
          <div
            className="flex items-center gap-1.5 text-xs text-labels-secondary min-w-0 px-2 py-1 rounded-lg bg-fills-f1"
            title="Patient for this study"
          >
            <User size={12} className="text-labels-tertiary shrink-0" />
            <span className="text-sm text-labels-primary font-medium truncate">
              {patientMeta.patientName || 'Unknown patient'}
            </span>
            {patientMeta.mrn && <span className="shrink-0">· MRN {patientMeta.mrn}</span>}
            {patientMeta.dob && <span className="shrink-0">· DOB {patientMeta.dob}</span>}
            {patientMeta.studyDate && <span className="shrink-0">· {patientMeta.studyDate}</span>}
          </div>
        )}
      </div>

      {/* View-mode tabs — clicking a tab rebuilds viewports over the same
          cached volume, no reload. */}
      <div className="flex items-center gap-1 text-sm">
        {Object.entries(VIEW_MODES).map(([key, cfg]) => (
          <ViewModeTab
            key={key}
            active={viewMode === key}
            label={cfg.name}
            tooltip={cfg.description}
            onClick={() => onSwitchMode(key)}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        {/* Follower: show when an operator is presenting live. */}
        {stage === 'ready' && readOnly && effectiveStudyId && operatorPresent && (
          <span className="text-xs px-2 py-1 rounded-lg bg-status-danger-soft text-status-danger flex items-center gap-1.5">
            <Radio size={12} className="animate-pulse" /> Following{operatorName ? ` ${operatorName}` : ''} · live
          </span>
        )}
        {/* Operator: Go-live toggle + participant count. */}
        {stage === 'ready' && studyId && !readOnly && (
          <>
            <button
              onClick={onToggleGoLive}
              className={`text-sm px-2 py-1 rounded-lg flex items-center gap-1.5 transition-[background-color,color] duration-150 ${
                goLive ? 'bg-status-danger text-white' : 'bg-fills-f1 hover:bg-fills-f2 text-labels-primary'
              }`}
              title={goLive
                ? 'Stop the live session'
                : 'Start a live session — viewers with the share link follow your view settings (view mode, window preset, invert, slab)'}
            >
              <Radio size={12} className={goLive ? 'animate-pulse' : ''} />
              {goLive ? 'Live' : 'Go live'}
              {goLive && participants > 1 && (
                <span className="inline-flex items-center gap-0.5 ml-0.5"><Users size={12} /> {participants}</span>
              )}
            </button>
            <button
              onClick={onShare}
              className="text-sm px-2 py-1 rounded-lg bg-fills-f1 hover:bg-fills-f2 text-labels-primary flex items-center gap-1.5 transition-[background-color] duration-150"
              title="Create a share link for this study"
            >
              <Share2 size={12} /> Share
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Top-bar tab for the view modes (MPR + 3D, Ceph, Pano, Cross-sections,
 * TMJ).
 */
export function ViewModeTab({ active = false, label, tooltip, onClick }) {
  return (
    <button
      title={tooltip || label}
      onClick={onClick}
      className={`px-2.5 py-1 rounded-lg text-sm tracking-wide transition-[background-color,color] duration-150 ${
        active
          ? 'bg-accent text-white cursor-default'
          : 'bg-transparent text-labels-secondary hover:bg-fills-f1 hover:text-labels-primary'
      }`}
    >
      {label}
    </button>
  );
}
