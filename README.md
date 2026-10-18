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
- **DICOM viewer** (`/viewer/dicom`): Cornerstone3D 4 stack viewport, every authorized series selectable, W/L, measurements
- **CBCT viewer** (`/viewer/cbct`): Cornerstone3D MPR + 3D volume, NIfTI fast path, pano / cross-sections / nerve and implant planning
- **Share links** (`/viewer/share/:token`): the token is resolved server-side by `api/imaging-share-resolve` into 10-minute signed URLs; the viewers run read-only from that payload
- **API routes** (`api/`, Vercel functions): `imaging-share-resolve`, `ai-infer`

## URL contract (mirrors the EMR's window.open targets)

```
/viewer/ios?id=<patient_files.id>&name=<filename>&type=<stl|ply|obj>
/viewer/ios?study=<imaging_studies.id>
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
npm test           # vitest unit tests (node)
npm run test:e2e   # Playwright smoke tests (starts the dev server)
npm run build      # production build (needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
```

CI (`.github/workflows/`) runs the build with inert placeholder values, the unit tests and the Playwright smoke tests.

## Deploy

Vercel builds `main` to production and every PR branch to a preview. Edge functions under `supabase/functions/` are deployed separately with the Supabase CLI; merging this repo does not redeploy them.
