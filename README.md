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
- **Auth:** shared Supabase project (`bxtqnfylaiimbgjweywi`) with the EMR. Same auth session — no handoff needed in phase 1
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

Auto-deploys to Vercel from the `main` branch. Domain: TBD.

## Next steps

See `handoff/IMAGING_SPLIT.md` in the EMR repo. Phase 1 milestones:
1. Move `src/components/ios-viewer/*` and `src/components/viewers/*` out of EMR
2. Add a feature flag in the EMR (`imaging.use_external_app`) that swaps window.open targets
3. AIHMC dogfood at `imaging.aihealth.app` for 2 weeks before flipping the flag for other tenants
