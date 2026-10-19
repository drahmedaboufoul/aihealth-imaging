# aiHealth Imaging

Standalone PACS + DICOM/CBCT/IOS viewer extracted from the aiHealth EMR.

**Status:** live — IOS, DICOM and CBCT viewers plus tokenized share links
**Live:** https://aihealth-imaging.vercel.app (Vercel, auto-deploys from `main`; PRs get preview builds)
**Sister project:** [aihealth-medical-center-billing](https://github.com/drahmedaboufoul/aihealth-medical-center-billing) (the EMR)
**Architecture notes:** [`handoff/INFRASTRUCTURE.md`](handoff/INFRASTRUCTURE.md)

## Why this exists separately

PACS and DICOM/CBCT/IOS viewing is a separate product, not an EMR feature. Different buyers (radiologists, imaging centres, dental imaging clinics), different scaling profile (petabyte storage, GPU rendering), different regulatory blast radius (medical-device classification when used for diagnosis).

## What is live

- **Stack:** Vite + React 18 + Tailwind + Radix/shadcn + Supabase (shared project with the EMR; same auth session)
- **IOS viewer** (`/viewer/ios`): Three.js multi-mesh STL/PLY/OBJ, Fussen vertex colour / texture sidecars, saved scan alignment
- **IOS workbench** (`/viewer/ios/workbench`): two-scan alignment, deviation map, occlusal contacts, measurements, cross-sections, versioned edits and exports — see below
- **DICOM viewer** (`/viewer/dicom`): Cornerstone3D 4 stack viewport, every authorized series selectable, W/L, measurements
- **CBCT viewer** (`/viewer/cbct`): Cornerstone3D MPR + 3D volume, NIfTI fast path, pano / cross-sections / nerve and implant planning
- **Share links** (`/viewer/share/:token`): the token is resolved server-side by `api/imaging-share-resolve` into 10-minute signed URLs; the viewers run read-only from that payload
- **API routes** (`api/`, Vercel functions): `imaging-share-resolve`, `ai-infer`

## URL contract (mirrors the EMR's window.open targets)

```
/viewer/ios?id=<patient_files.id>&name=<filename>&type=<stl|ply|obj>
/viewer/ios?study=<imaging_studies.id>
/viewer/ios/workbench                                   # local STL/PLY/OBJ files (read in the browser, never uploaded)
/viewer/ios/workbench?study=<id>[&compare=<id>]          # a study's scans (signed in), optionally two visits
/viewer/dicom?id=<patient_files.id> | ?path=<bucket/key> | ?study=<imaging_studies.id>
/viewer/cbct?study=<imaging_studies.id>
/viewer/share/<token>     # public, read-only
/health                   # liveness
```

## M0 safety defaults (October 2026)

- **Outside AI is off.** The radiograph / CBCT "AI read" controls send patient images to a third-party AI provider; they only render when the build sets `VITE_ENABLE_THIRD_PARTY_AI=true`. The `ai-read-radiograph` edge function refuses (403) unless its secret `ALLOW_CROSS_BORDER_AI=true` is set (`DISABLE_CROSS_BORDER_AI=true` still wins). The EMR-hosted `ai-read-cbct` function needs the same change in the EMR repo.
- **Share caps:** links last at most 7 days and 20 views. The viewer mints within the caps and the resolver refuses anything outside them, including EMR-minted invites.
- **Outward pages** (share / read-only) show no patient name or ID and no row IDs; exports are named `scan-YYYY-MM-DD.nii.gz`; error text is sanitized on staff and share pages.
- **Share links** are minted on `VITE_PUBLIC_VIEWER_URL` only (no current-origin fallback in production builds).
- **CORS** on `api/*` is an allowlist (`ALLOWED_ORIGINS`, default: this viewer + the staff EMR), never `*`.
- **Viewer rooms** (live co-viewing) are off unless `VITE_ENABLE_VIEWER_ROOMS=true`. They use a public Realtime channel keyed by the study ID and must not be re-enabled before M1 (private channel + RLS policy + server-issued room id).
- **Config:** `vite build` fails without the required client variables; a missing config shows a "Viewer not configured" screen instead of a blank page; `api/*` answers 503 when its server variables are missing (no `VITE_` fallbacks server-side).
- No external font CDNs: Inter / JetBrains Mono are used when installed locally, otherwise the system font stacks.

## IOS workbench v1 (October 2026)

Open from the IOS viewer's **Workbench** button (staff sessions) or directly with local files. Everything
runs in the browser: scans are parsed in a Web Worker, indexed with three-mesh-bvh, and never sent anywhere.

| Feature | Notes |
|---|---|
| Layouts | Single, side by side with linked cameras (rotation + zoom; each pane keeps its own centre), overlay with per-scan colour and opacity |
| Alignment | Optional 3-point landmarks (Horn), then point-to-plane ICP with outlier rejection (distance cap, k x median, normal angle) and a report (RMS, iterations, inliers). Undo with Ctrl+Z. **Draft until a named person accepts it**; an accepted alignment can be saved as a new version |
| Deviation map | Signed closest-point distance in mm (BVH), adjustable colour range, ±0.05 / ±0.1 / ±0.2 tolerance bands by surface area, histogram, hover readout |
| Contacts | Any two meshes (user picks upper/lower): contact < 0, near 0–0.1, close 0.1–0.3 mm (editable), contact area per band, contact patches, occlusal side-by-side view. **Draft until accepted** |
| Measurements | Distance, angle, surface path (graph path straightened on the surface), lasso area, cross-section with 2D profile, width/height and gap between visits. JSON export/import `measurements-YYYY-MM-DD.json`; typed persistence interface for the later database milestone |
| Edits | Trim by lasso or plane, fill small holes, decimate (QEM) to a target, Laplacian/Taubin smoothing. Each edit is a new in-memory version with parent, operation, parameters, SHA-256 of the output and of {op, params, parent}; the original is immutable |
| Exports | Current version as binary STL or PLY, PNG with a true scale bar (orthographic view) and legend. Neutral names: `scan-YYYY-MM-DD-a-v2.stl`, `scan-YYYY-MM-DD-deviation.png` |

Keyboard: `O` open · `1/2/3` layouts · `L` link cameras · `A D C M S E V X` tools · `F` fit · `Ctrl+Z` undo alignment · `Esc` cancel · `?` help.
Mouse: right-drag rotates, middle-drag pans, wheel zooms, left-click picks when a tool needs it.

Not yet: saving versions/measurements to the clinic database (M1 `scan_versions`), "fix bite", 3Shape DCM/HPS,
manifold-3d (it needs closed meshes; intraoral scans are open surfaces, so v1 uses its own JS edits).

Checks: `npm run typecheck`, `npm run lint` (workbench code), `npm test` (includes `tests/workbench/*`),
`npm run test:e2e` (includes `tests/e2e/ios-workbench.e2e.ts` with generated fixtures).
Performance (opt-in): `WORKBENCH_PERF=1 npx vitest run tests/workbench/perf2m.test.ts` (Node) and
`WORKBENCH_PERF=1 npx playwright test -c playwright.perf.config.ts tests/e2e/ios-workbench.e2e.ts -g 2M` (browser, GPU).

## Configuration

Variable **names** (no values) are listed in [`.env.example`](.env.example). Copy it to `.env.local` for local dev and set the same names on Vercel (and as Supabase function secrets for the edge function).

## Local dev

```bash
npm ci
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:5174
```

## Tests

```bash
npm run typecheck  # tsc (whole app) + strict tsc for src/workbench
npm run lint       # ESLint for the IOS workbench code
npm test           # vitest unit tests (node)
npm run test:e2e   # Playwright e2e tests (starts the dev server)
npm run build      # production build (needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
```

CI (`.github/workflows/`) runs typecheck, lint, the build with inert placeholder values, the unit tests and the Playwright tests.

## Deploy

Vercel builds `main` to production and every PR branch to a preview. Edge functions under `supabase/functions/` are deployed separately with the Supabase CLI; merging this repo does not redeploy them.
