# aiHealth Imaging

Standalone PACS + DICOM/CBCT/IOS viewer extracted from the aiHealth EMR.

**Status:** scaffold (phase 1 — extraction in progress)
**Live:** _not yet deployed_
**Sister project:** [aihealth-medical-center-billing](https://github.com/drahmedaboufoul/aihealth-medical-center-billing) (the EMR)
**Contract:** see `handoff/IMAGING_SPLIT.md` in the EMR repo for the full extraction plan and API surface

## Why this exists separately

PACS and DICOM/CBCT/IOS viewing is a separate product, not an EMR feature. Different buyers (radiologists, imaging centres, dental imaging clinics), different scaling profile (petabyte storage, GPU rendering), different regulatory blast radius (medical-device classification when used for diagnosis). See the architectural rationale in the EMR repo's `handoff/IMAGING_SPLIT.md`.

## Phase 1 architecture

- **Stack:** Vite + React 18 + Tailwind + shadcn/ui + Supabase
- **Auth:** shared Supabase project (`<your-supabase-project>`) with the EMR. Same auth session — no handoff needed in phase 1
- **Storage:** reads from EMR's existing `patient-files` and `encounter-files` Supabase storage buckets (no migration in phase 1)
- **Renderer:** Three.js for 3D meshes today; will adopt Cornerstone3D + OHIF Viewer for DICOM/CBCT in phase 2
- **Embed:** EMR opens viewers via `window.open('imaging.aihealth.app/viewer/...')`

## URL contract (mirrors the EMR's existing window.open targets)

```
/viewer/ios?id=<patient_files.id>&name=<filename>&type=<stl|ply|obj>
/viewer/dicom?id=<patient_files.id>&name=<filename>
/viewer/cbct?id=<patient_files.id>&patient=<customers.id>
/study/:studyId          # future
/health                  # liveness
```

## Local dev

```bash
npm install
npm run dev    # http://localhost:5174
```

## Deploy

Auto-deploys to Vercel from the `main` branch. One codebase, two Vercel projects:

| Vercel project | Backend | What it serves |
|---|---|---|
| `aihealth-imaging` (existing) | AIHMC EMR Supabase project | this app's CBCT viewer, EMR share links (`/api/imaging-share-resolve`) |
| kyour imaging cloud (new) | kyour Supabase project, `VITE_IMAGING_BACKEND=kyour` | kyour's CBCT viewer (MPR/3D/pano/implant/TMJ/ceph, AI read with AI tokens), Dental Lab OS launch links (`/launch`), shares via kyour's `imaging-partner` function |

Environment variables:

- Both: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the project's URL and publishable/anon key).
- Existing EMR project only (server routes in `api/`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `VITE_PUBLIC_VIEWER_URL`, and for `/api/ai-infer` `AI_INFERENCE_URL` + `INFERENCE_INTERNAL_KEY`.
- kyour imaging cloud only: `VITE_IMAGING_BACKEND=kyour`. No server keys: kyour's edge functions do the
  privileged work. Add the project's URL to kyour's `imaging_partners.viewer_urls` (first entry = default) so
  partner launch links point at it.

`/viewer/local` (open a scan from this computer, nothing uploaded) works in both. `npm run build` with
`node scripts/make-sample-cbct.mjs` regenerates the demo phantom in `public/samples`.

## Next steps

See `handoff/IMAGING_SPLIT.md` in the EMR repo. Phase 1 milestones:
1. Move `src/components/ios-viewer/*` and `src/components/viewers/*` out of EMR
2. Add a feature flag in the EMR (`imaging.use_external_app`) that swaps window.open targets
3. AIHMC dogfood at `imaging.aihealth.app` for 2 weeks before flipping the flag for other tenants
