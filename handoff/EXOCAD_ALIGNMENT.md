# Exocad-aligned 3D viewer interaction — phase 2.5 plan

**Status:** plan, not implemented
**Last updated:** 2026-05-06
**Owner:** Dr Ahmed (AIHHS)
**Predecessor:** the IOS viewer ported in phase 2 (this commit) inherits the EMR's existing interaction model. That model is functional but does NOT match the exocad / dental-CAD industry standard. This document captures the gap and the work needed to close it.

---

## Why exocad standards matter

Exocad GmbH (now part of Align Technology) is the dominant dental CAD/CAM software in clinics and labs worldwide. Dentists, technicians, and assistants who handle digital scans daily are trained on its interaction model. When our viewer behaves differently, every click costs time and creates friction. Aligning to exocad's conventions means anyone who has ever touched a digital scan can drive our viewer with zero training.

Two other commercial viewers — **Medit Link** and **3Shape Communicate** — converge on roughly the same conventions. So aligning to exocad effectively aligns to the industry as a whole.

---

## Gap analysis — current viewer vs exocad

| Behaviour | Exocad standard | Current viewer | Status |
|---|---|---|---|
| Rotate | Right-click drag | Left-click drag (default) | Wrong |
| Pan | Middle-click drag (or shift + right-click) | Right-click drag | Wrong |
| Zoom | Scroll wheel | Scroll wheel | OK |
| Pick / select | Left-click | Conflict with rotate | Wrong |
| Reset view | Double-click empty area, or `Home` key | Reset button only | Partial |
| Front view | Numpad 1 / button "Front" | None | Missing |
| Back view | Ctrl+Numpad 1 | None | Missing |
| Right view | Numpad 3 | None | Missing |
| Left view | Ctrl+Numpad 3 | None | Missing |
| Top (occlusal) view | Numpad 7 | Tool button "Occlusal Contact" (different meaning) | Missing |
| Bottom view | Ctrl+Numpad 7 | None | Missing |
| Buccal | Side view aligned to mesh axis | None | Missing |
| Lingual | Opposite of buccal | None | Missing |
| Mesial / Distal | Aligned to dental arch | None | Missing |
| Auto-frame on load | Yes — fit-to-bounding-box | No — fixed camera distance | Wrong |
| Articulator coordinate system | Yes — maxilla up, mandible down, occlusal plane horizontal | Generic Y-up scene | Wrong |
| Bite-plane visualisation | Optional toggle | None | Missing |
| Snap to axis on rotate | Soft snap to 90°/45° increments | None | Missing |
| Scan orientation correction | Yes — auto-detect maxilla vs mandible from STL header / shape heuristics | None | Missing |
| Measurement units | mm, displayed in 3D + 2D ruler overlay | mm displayed but no live ruler | Partial |
| Cross-section / clipping plane | Movable clip plane with drag handle | Hooks exist (`useCrossSection`) but UI not wired | Partial |
| Vertex-color toggle | Yes (PVS scans have color) | Auto-detect, no toggle | Partial |

---

## Phase 2.5 — concrete plan

Pulling exocad-grade interaction into this app is a focused effort, not a rewrite. The existing `ModelViewer.tsx` keeps its structure; we change the parts that drive interaction.

### Step 1 — coordinate system

Adopt exocad's articulator frame as the canonical world space:
- **Y-up**, occlusal plane on Y=0
- **Maxilla** (upper jaw) above origin
- **Mandible** (lower jaw) below
- Camera default looks down the +Z axis (occlusal view) — closest to the orientation the user sees during chairside scanning

On load, run a heuristic to auto-orient an unknown STL:
1. Compute mesh bounding box
2. Identify the longest axis (anteroposterior in a dental arch)
3. Identify the most curved axis (the dental arch itself)
4. Rotate so curvature is in XZ and the convex side faces +Y for maxilla / -Y for mandible
5. Scale so the bounding-box diagonal is ~50mm (typical full-arch scan)

This is conservative — if the mesh isn't a dental arch, the heuristic fails gracefully and the user can re-orient with the keyboard shortcuts in step 3.

### Step 2 — auto-frame camera

Replace the fixed camera at `[0, 0, 5]` with a frustum that matches the mesh:
- After geometry loads, compute bounding box
- Set camera distance = `boundingSphere.radius / Math.tan(fov/2 * π/180) * 1.2`
- Position along the +Z axis (default occlusal view)
- Orient `up` to +Y

This works for any mesh scale — robot models, dental scans, microscopic slides — same result: the mesh fills ~80% of the viewport.

### Step 3 — exocad-style mouse + keyboard

Replace OrbitControls' default button mapping:

```js
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE_DISABLED,  // pick only
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};
```

Numpad keyboard shortcuts wired via `useEffect` listening on `window`:

| Key | Action |
|---|---|
| Numpad 1 | Front view |
| Ctrl+Numpad 1 | Back view |
| Numpad 3 | Right view |
| Ctrl+Numpad 3 | Left view |
| Numpad 7 | Top view (occlusal) |
| Ctrl+Numpad 7 | Bottom view |
| Numpad 5 | Toggle perspective / orthographic |
| Home | Reset view + auto-frame |
| F | Frame to selected mesh |
| Numpad . | Frame to cursor |

These are exocad-standard. Anyone who's used the software will already know them.

### Step 4 — view preset chips

A row of chips along the top: `Front · Back · Right · Left · Occlusal · From below · Buccal · Lingual · Mesial · Distal`. Clicking one animates the camera to that preset over ~400ms with cubic easing — same as exocad's view button behaviour.

The dental-specific presets (Buccal/Lingual/Mesial/Distal) require knowing which side is which, so they only become active after the orientation heuristic from step 1 has resolved. Until then they're greyed out with a tooltip.

### Step 5 — bite plane + articulator overlay

A thin transparent plane at Y=0 representing the occlusal plane. Toggleable. When both maxilla and mandible are loaded, this is the bite plane between them. When only one arch is loaded, it's a reference plane.

Plus an optional articulator hinge axis (the line approximating the temporomandibular joint axis) — drawn as a horizontal line at `Y = -mandible_height * 0.3, Z = -mandible_depth * 1.5`. Toggleable. Used by orthodontists and prosthodontists.

### Step 6 — cross-section as exocad does it

The existing `useCrossSection` hook is unwired. Wire it as:
- A movable horizontal plane (default: occlusal)
- Drag handle at the side of the viewport to move it up/down
- Mesh is clipped by the plane in real time
- Dual-pass rendering: the cut surface gets a saturated colour fill so the user can read the cross-section like a 2D image

This is what exocad calls "tooth section" view — it's how you check crown thickness during design.

### Step 7 — interaction telemetry

Phase 2.5 is the right time to add lightweight telemetry: which view presets get used, how often the cross-section is dragged, how long users spend in the viewer. This data informs phase 3 priorities. Use Supabase `imaging_audit_log` table (already in INFRASTRUCTURE.md plan).

---

## Estimated work

Each step is roughly half a day of focused work. Total ~3-4 days end-to-end. None of it is conceptually hard — it's UX rigour against a known-good reference (exocad). The hardest piece is step 1 (auto-orientation heuristic) because heuristics fail in edge cases; we ship a v1 that handles the common case and falls back gracefully.

---

## What lands in phase 2 (now) vs phase 2.5 (later)

| Task | Phase 2 (now) | Phase 2.5 |
|---|---|---|
| Move IOS components from EMR | ✓ done | — |
| Stop the "reload on tool click" bug | ✓ done (memo'd scan/patient) | — |
| Right-click rotate default | ✓ done (mouseSettings flipped) | — |
| Articulator coordinate system | — | ✓ |
| Auto-frame camera | — | ✓ |
| Numpad shortcuts | — | ✓ |
| View preset chips | — | ✓ |
| Bite plane overlay | — | ✓ |
| Cross-section UI | — | ✓ |
| Auto-orientation heuristic | — | ✓ |
| Telemetry | — | ✓ |

Phase 2 lands the structural extraction. Phase 2.5 makes the viewer feel professional. They're separate milestones intentionally — extraction has to ship before polish.

---

## Reference reading

- exocad documentation: https://exocad.com (training videos demonstrate the interaction model — can't replicate the conventions without seeing them in motion)
- Three.js OrbitControls source: how to remap mouse buttons cleanly
- Cornerstone3D's PanTool / ZoomTool / CrosshairsTool: same interaction patterns we're targeting, expressed as composable tools (good model when phase 3 brings DICOM in)
