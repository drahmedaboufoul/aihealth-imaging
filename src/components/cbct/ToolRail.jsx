/*
 * ToolRail — the CBCT viewer's left control area, rebuilt for W7 (audit
 * #7/#9/#10) as:
 *
 *   ┌──────┬────────────────────────────┐
 *   │ 48px │ 280px tabbed context panel │
 *   │ tool │  Image / Measure / Plan/AI │
 *   │ strip│                            │
 *   └──────┴────────────────────────────┘
 *
 * The strip carries every primary-click tool plus the explicit trace
 * toggles (Trace Nerve / Place Implant / Trace Arch — mirroring the Trace
 * Arch pattern: when armed, ANY left-click captures; Shift+Click keeps
 * working as the shortcut). The panel holds the contextual controls that
 * used to be crammed into the old 200px, 11-section rail.
 *
 * Plan tab renders only in planning-relevant modes (mpr-3d / pano /
 * crosssec); the AI tab is hidden in read-only/shared sessions.
 */
import { useEffect, useState } from 'react';
import {
  RotateCcw, Trash2, Save, Sparkles, Contrast, Eye, EyeOff,
  Cylinder, GitBranch, Activity, ExternalLink, Image as ImageIcon,
  Ruler, Layers, Undo2,
} from 'lucide-react';
import { IMPLANT_CATALOG, CROSSSEC_COUNT } from './cbctViewModes';
import { segmentToPolylineDistance } from './cbctMath';
import {
  ToolButton, PanelButton, ViewerSlider, SectionLabel, StripDivider,
} from '../viewer/controls';
import {
  CBCT_MEASURE_TOOLS, CBCT_ROI_TOOLS, CBCT_NAV_TOOLS,
} from '../viewer/viewerToolConfig';
import { ENABLE_PLACEHOLDER_AI_MODELS } from '../../lib/featureFlags';

// Modes where planning tools (implants / nerve / arch) make sense.
const PLAN_MODES = new Set(['mpr-3d', 'pano', 'crosssec']);

export default function ToolRail({
  viewMode,
  // tools
  activeTool,
  onSelectTool,
  readOnly,
  onResetViews,
  onSaveMeasurements,
  onClearMeasurements,
  // display
  invert,
  onToggleInvert,
  showRefLines,
  onToggleRefLines,
  slabThickness,
  onSlabChange,
  // presets
  presetTable,
  activePreset,
  onApplyPreset,
  // measurements
  annotations,
  // implants
  implants,
  placingImplant,
  pendingApex,
  implantCatalogOpen,
  onToggleCatalog,
  onPickImplant,
  onCancelPlacement,
  onClearImplants,
  onOpenPromote,
  // nerve
  nervePoints,
  tracingNerve,
  onToggleTracingNerve,
  safetyZoneMM,
  onSafetyZoneChange,
  nerveSlabMM,
  onNerveSlabChange,
  onUndoNerve,
  onClearNerve,
  // arch (pano / cross-sections)
  archPointCount,
  tracingArch,
  onToggleTracingArch,
  archSlabMM,
  onArchSlabChange,
  onArchUndo,
  onArchReset,
  archAiRunning,
  onRunArchAi,
  // cross-sections
  xsWidthMM,
  onXsWidthChange,
  // AI
  onOpenAi,
}) {
  const planAvailable = PLAN_MODES.has(viewMode);
  const [tab, setTab] = useState('image');

  // Keep the active tab valid across mode switches / session role changes.
  useEffect(() => {
    if (tab === 'plan' && !planAvailable) setTab('image');
    if (tab === 'ai' && readOnly) setTab('image');
  }, [tab, planAvailable, readOnly]);

  const tabs = [
    { key: 'image', label: 'Image', icon: ImageIcon },
    { key: 'measure', label: 'Measure', icon: Ruler },
    ...(planAvailable ? [{ key: 'plan', label: 'Plan', icon: Cylinder }] : []),
    ...(!readOnly ? [{ key: 'ai', label: 'AI', icon: Sparkles }] : []),
  ];

  // Strip implant tool: arm placement (opens the catalog in the Plan tab);
  // clicking again while armed cancels — mirrors the Trace Nerve toggle.
  const onImplantStripClick = () => {
    if (placingImplant) {
      onCancelPlacement();
    } else {
      setTab('plan');
      if (!implantCatalogOpen) onToggleCatalog();
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* ── 48px icon tool strip ───────────────────────────────────── */}
      <div className="flex flex-col items-center w-12 shrink-0 py-2 gap-1 bg-background-secondary border-r border-separator-s1 overflow-y-auto">
        {CBCT_MEASURE_TOOLS.map((t) => (
          <ToolButton
            key={t.key}
            active={activeTool === t.key}
            onClick={() => onSelectTool(t.key)}
            icon={t.icon}
            label={t.label}
          />
        ))}
        <StripDivider />
        {CBCT_ROI_TOOLS.map((t) => (
          <ToolButton
            key={t.key}
            active={activeTool === t.key}
            onClick={() => onSelectTool(t.key)}
            icon={t.icon}
            label={t.label}
          />
        ))}
        <StripDivider />
        {CBCT_NAV_TOOLS.map((t) => (
          <ToolButton
            key={t.key}
            active={activeTool === t.key}
            onClick={() => onSelectTool(t.key)}
            icon={t.icon}
            label={t.label}
          />
        ))}
        <ToolButton active={false} onClick={onResetViews} icon={RotateCcw} label="Reset views (R)" />

        {/* Explicit trace toggles — discoverable alternatives to the
            Shift+Click shortcut (audit #10), contextual per mode. */}
        {viewMode === 'mpr-3d' && (
          <>
            <StripDivider />
            <ToolButton
              active={tracingNerve}
              tone="success"
              onClick={onToggleTracingNerve}
              icon={GitBranch}
              label={tracingNerve ? 'Tracing nerve — click on MPR to add points' : 'Trace nerve canal'}
            />
            <ToolButton
              active={!!placingImplant}
              onClick={onImplantStripClick}
              icon={Cylinder}
              label={placingImplant ? 'Cancel implant placement' : 'Place implant'}
            />
          </>
        )}
        {viewMode === 'pano' && (
          <>
            <StripDivider />
            <ToolButton
              active={tracingArch}
              onClick={onToggleTracingArch}
              icon={Activity}
              label={tracingArch ? 'Tracing arch — click on axial to add points' : 'Trace Arch'}
            />
          </>
        )}

        <StripDivider />
        {!readOnly && (
          <ToolButton active={false} onClick={onSaveMeasurements} icon={Save} label="Save measurements" />
        )}
        <ToolButton active={false} onClick={onClearMeasurements} icon={Trash2} label="Clear annotations" danger />
      </div>

      {/* ── 280px tabbed context panel ─────────────────────────────── */}
      <div className="w-[280px] shrink-0 flex flex-col min-h-0 bg-background-secondary border-r border-separator-s1">
        <div role="tablist" aria-label="Viewer panels" className="flex gap-1 p-2 border-b border-separator-s1">
          {tabs.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm transition-[background-color,color] duration-150 ${
                  active
                    ? 'bg-fills-f2 text-labels-primary'
                    : 'text-labels-secondary hover:bg-fills-f1 hover:text-labels-primary'
                }`}
              >
                <Icon size={13} />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {tab === 'image' && (
            <ImagePanel
              invert={invert}
              onToggleInvert={onToggleInvert}
              showRefLines={showRefLines}
              onToggleRefLines={onToggleRefLines}
              slabThickness={slabThickness}
              onSlabChange={onSlabChange}
              presetTable={presetTable}
              activePreset={activePreset}
              onApplyPreset={onApplyPreset}
            />
          )}
          {tab === 'measure' && <MeasurePanel annotations={annotations} />}
          {tab === 'plan' && planAvailable && (
            <PlanPanel
              viewMode={viewMode}
              readOnly={readOnly}
              implants={implants}
              placingImplant={placingImplant}
              pendingApex={pendingApex}
              implantCatalogOpen={implantCatalogOpen}
              onToggleCatalog={onToggleCatalog}
              onPickImplant={onPickImplant}
              onCancelPlacement={onCancelPlacement}
              onClearImplants={onClearImplants}
              onOpenPromote={onOpenPromote}
              nervePoints={nervePoints}
              tracingNerve={tracingNerve}
              onToggleTracingNerve={onToggleTracingNerve}
              safetyZoneMM={safetyZoneMM}
              onSafetyZoneChange={onSafetyZoneChange}
              nerveSlabMM={nerveSlabMM}
              onNerveSlabChange={onNerveSlabChange}
              onUndoNerve={onUndoNerve}
              onClearNerve={onClearNerve}
              archPointCount={archPointCount}
              tracingArch={tracingArch}
              onToggleTracingArch={onToggleTracingArch}
              archSlabMM={archSlabMM}
              onArchSlabChange={onArchSlabChange}
              onArchUndo={onArchUndo}
              onArchReset={onArchReset}
              archAiRunning={archAiRunning}
              onRunArchAi={onRunArchAi}
              xsWidthMM={xsWidthMM}
              onXsWidthChange={onXsWidthChange}
            />
          )}
          {tab === 'ai' && !readOnly && <AiTabPanel onOpenAi={onOpenAi} />}
        </div>
      </div>
    </div>
  );
}

/* ── Image tab: display toggles, slab, W/L presets, shortcut help ────── */
function ImagePanel({
  invert, onToggleInvert, showRefLines, onToggleRefLines,
  slabThickness, onSlabChange, presetTable, activePreset, onApplyPreset,
}) {
  return (
    <div className="space-y-3">
      <div>
        <SectionLabel className="mb-1.5">Display</SectionLabel>
        <div className="grid grid-cols-2 gap-1">
          <PanelButton active={invert} onClick={onToggleInvert} title="Invert greyscale (I)">
            <Contrast size={13} /> Invert
          </PanelButton>
          <PanelButton active={showRefLines} onClick={onToggleRefLines} title="Crosshair reference lines">
            {showRefLines ? <Eye size={13} /> : <EyeOff size={13} />} Ref lines
          </PanelButton>
        </div>
        <div className="mt-2">
          <ViewerSlider
            label="Slab MIP"
            icon={Layers}
            value={slabThickness}
            min={0}
            max={30}
            step={1}
            unit=" mm"
            onChange={onSlabChange}
          />
        </div>
      </div>

      <div>
        <SectionLabel className="mb-1.5">MPR window</SectionLabel>
        <div className="grid grid-cols-2 gap-1">
          {presetTable.map((p) => (
            <PanelButton
              key={p.name}
              active={activePreset === p.name}
              onClick={() => onApplyPreset(p)}
            >
              {p.name}
            </PanelButton>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel className="mb-1.5">Shortcuts</SectionLabel>
        <p className="text-xs text-labels-tertiary leading-relaxed">
          <span className="text-labels-primary">1–5</span> tools · <span className="text-labels-primary">6/7</span> pan/zoom<br />
          <span className="text-labels-primary">R</span> reset · <span className="text-labels-primary">I</span> invert<br />
          <span className="text-labels-primary">Right-drag</span> = W/L<br />
          <span className="text-labels-primary">Wheel</span> = scroll slices
        </p>
      </div>
    </div>
  );
}

/* ── Measure tab: clinical measurements list ─────────────────────────── */
function MeasurePanel({ annotations }) {
  return (
    <div>
      <SectionLabel className="mb-1.5">
        Measurements <span className="text-labels-quaternary">({annotations.length})</span>
      </SectionLabel>
      <div className="space-y-1">
        {annotations.length === 0 && (
          <p className="text-sm text-labels-tertiary italic">
            No measurements yet — they appear here as you draw with the
            measure tools.
          </p>
        )}
        {annotations.map((a) => (
          <div
            key={a.uid}
            className="flex items-center justify-between bg-fills-f1 rounded-lg px-2 py-1.5"
          >
            <span className="text-sm text-labels-secondary">{a.toolName}</span>
            <span className="text-sm font-mono tabular-nums text-accent">{a.display}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Plan tab: implants + nerve (mpr-3d), arch (pano/crosssec) ───────── */
function PlanPanel({
  viewMode,
  readOnly,
  implants, placingImplant, pendingApex, implantCatalogOpen,
  onToggleCatalog, onPickImplant, onCancelPlacement, onClearImplants, onOpenPromote,
  nervePoints, tracingNerve, onToggleTracingNerve,
  safetyZoneMM, onSafetyZoneChange, nerveSlabMM, onNerveSlabChange, onUndoNerve, onClearNerve,
  archPointCount, tracingArch, onToggleTracingArch,
  archSlabMM, onArchSlabChange, onArchUndo, onArchReset, archAiRunning, onRunArchAi,
  xsWidthMM, onXsWidthChange,
}) {
  const showAiAutoTrace = ENABLE_PLACEHOLDER_AI_MODELS && !readOnly;
  return (
    <div className="space-y-4">
      {viewMode === 'mpr-3d' && (
        <>
          {/* Implants */}
          <div>
            <SectionLabel className="mb-1.5">
              Implants {implants.length > 0 && <span className="text-labels-quaternary">({implants.length})</span>}
            </SectionLabel>
            <div className="space-y-1.5">
              <PanelButton
                active={!!placingImplant}
                onClick={placingImplant ? onCancelPlacement : onToggleCatalog}
              >
                <Cylinder size={13} />
                {placingImplant
                  ? (pendingApex ? 'Click HEAD (crestal)' : 'Click APEX (deep)')
                  : 'Place implant'}
              </PanelButton>
              {implantCatalogOpen && !placingImplant && (
                <div className="rounded-lg p-1 space-y-0.5 max-h-40 overflow-y-auto bg-background-tertiary">
                  {IMPLANT_CATALOG.map((cat) => (
                    <button
                      key={cat.label}
                      type="button"
                      onClick={() => onPickImplant(cat)}
                      className="w-full text-left text-sm px-2 py-1 rounded-md text-labels-secondary hover:bg-accent hover:text-white transition-[background-color,color] duration-150"
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              )}
              {placingImplant && (
                <PanelButton danger onClick={onCancelPlacement}>
                  Cancel placement
                </PanelButton>
              )}
              {implants.length > 0 && (
                <>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {implants.map((imp) => {
                      const nerveDistMM = nervePoints.length >= 2
                        ? segmentToPolylineDistance(imp.apex, imp.head, nervePoints)
                        : null;
                      const tooClose = nerveDistMM != null && nerveDistMM < safetyZoneMM;
                      return (
                        <div
                          key={imp.id}
                          className="flex items-center justify-between bg-fills-f1 rounded-lg px-2 py-1.5"
                        >
                          <span className="text-sm text-labels-primary">{imp.label}</span>
                          {nerveDistMM != null && (
                            <span
                              className={`text-sm font-mono tabular-nums ${tooClose ? 'text-status-danger' : 'text-status-success'}`}
                              title={tooClose ? 'Inside the nerve safety zone' : 'Clear of the nerve safety zone'}
                            >
                              {nerveDistMM.toFixed(1)}mm
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {!readOnly && (
                    <PanelButton onClick={onOpenPromote} title="Create a Treatment Plan in the EMR linked to this study">
                      <ExternalLink size={13} /> Promote to Plan
                    </PanelButton>
                  )}
                  <PanelButton danger onClick={onClearImplants}>
                    Clear all implants
                  </PanelButton>
                </>
              )}
            </div>
          </div>

          {/* Nerve canal */}
          <div>
            <SectionLabel className="mb-1.5">
              Nerve canal {nervePoints.length > 0 && <span className="text-labels-quaternary">({nervePoints.length})</span>}
            </SectionLabel>
            <div className="space-y-1.5">
              <PanelButton tone="success" active={tracingNerve} onClick={onToggleTracingNerve}>
                <GitBranch size={13} />
                {tracingNerve ? 'Tracing — click on MPR' : 'Trace nerve canal'}
              </PanelButton>
              {nervePoints.length > 0 && (
                <>
                  <ViewerSlider
                    label="Safety zone"
                    value={safetyZoneMM}
                    min={1}
                    max={5}
                    step={0.5}
                    unit=" mm"
                    onChange={onSafetyZoneChange}
                  />
                  <ViewerSlider
                    label="Slab"
                    title="How thick a slab to highlight bright on each MPR slice"
                    value={nerveSlabMM}
                    min={1}
                    max={20}
                    step={1}
                    unit=" mm"
                    onChange={onNerveSlabChange}
                  />
                  <div className="flex gap-1">
                    <PanelButton onClick={onUndoNerve} className="flex-1">
                      <Undo2 size={13} /> Undo
                    </PanelButton>
                    <PanelButton danger onClick={onClearNerve} className="flex-1">
                      Clear
                    </PanelButton>
                  </div>
                </>
              )}
              <p className="text-xs text-labels-tertiary leading-relaxed">
                Enable tracing then click points along the canal on any MPR
                pane. Shift+Click also adds a point without enabling tracing.
              </p>
            </div>
          </div>
        </>
      )}

      {(viewMode === 'pano' || viewMode === 'crosssec') && (
        <>
          {/* Arch curve */}
          <div>
            <SectionLabel className="mb-1.5">
              Arch curve {archPointCount > 0 && <span className="text-labels-quaternary">({archPointCount})</span>}
            </SectionLabel>
            <div className="space-y-1.5">
              <PanelButton active={tracingArch} onClick={onToggleTracingArch}>
                <Activity size={13} />
                {tracingArch ? 'Tracing — click on axial' : 'Trace Arch'}
              </PanelButton>
              {showAiAutoTrace && (
                <PanelButton
                  tone="ai"
                  onClick={onRunArchAi}
                  disabled={!!archAiRunning}
                  title="AI auto-traces the dental arch (SIMULATED output — dev placeholder model)"
                >
                  <Sparkles size={13} />
                  {archAiRunning ? 'AI running…' : 'AI auto-trace (simulated)'}
                </PanelButton>
              )}
              {archPointCount > 0 && (
                <>
                  <ViewerSlider
                    label="Slab"
                    value={archSlabMM}
                    min={2}
                    max={20}
                    step={1}
                    unit=" mm"
                    onChange={onArchSlabChange}
                  />
                  <div className="flex gap-1">
                    <PanelButton onClick={onArchUndo} className="flex-1">
                      <Undo2 size={13} /> Undo last
                    </PanelButton>
                    <PanelButton danger onClick={onArchReset} className="flex-1">
                      Reset
                    </PanelButton>
                  </div>
                </>
              )}
              <p className="text-xs text-labels-tertiary leading-relaxed">
                Click <b>Trace Arch</b> then click ≥3 points along the arch
                midline on axial (anterior → premolar → molar → posterior).
                Shift+Click also works without enabling tracing.
              </p>
            </div>
          </div>

          {/* Cross-section settings (crosssec mode only) */}
          {viewMode === 'crosssec' && (
            <div>
              <SectionLabel className="mb-1.5">Cross-sections</SectionLabel>
              <ViewerSlider
                label="Slice width"
                value={xsWidthMM}
                min={15}
                max={50}
                step={1}
                unit=" mm"
                onChange={onXsWidthChange}
              />
              <p className="text-xs text-labels-tertiary leading-relaxed mt-1.5">
                {CROSSSEC_COUNT} cross-sections evenly spaced along the arch
                curve.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── AI tab: entry point to the AI dialog (authed sessions only) ─────── */
function AiTabPanel({ onOpenAi }) {
  return (
    <div className="space-y-2">
      <SectionLabel>AI · CBCT</SectionLabel>
      <p className="text-sm text-labels-secondary leading-relaxed">
        Run a live vision read of the panes currently on screen, or review
        the segmentation model roadmap.
      </p>
      <PanelButton tone="ai" onClick={onOpenAi} className="w-full">
        <Sparkles size={13} /> Open AI panel
      </PanelButton>
    </div>
  );
}
