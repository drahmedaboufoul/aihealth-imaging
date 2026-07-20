# aiHealth Imaging — infrastructure architecture

**Status:** plan, not yet implemented
**Last updated:** 2026-05-06
**Related:** `IMAGING_SPLIT.md` in the EMR repo (the extraction contract)

This document captures *where each part of the imaging product runs* and *why*. Vercel is the right home for the React shell, but it is wrong for everything else — DICOMweb serving, AI inference, long-running processing, and petabyte storage all need different infra. This is the layered architecture we're building toward.

---

## 1. The five-layer reality

Most of what users perceive as "DICOM viewing" is actually browser-side rendering via Cornerstone3D / WebGL. The server-side work is concentrated in narrow places: study retrieval, decompression, AI inference, blob storage. Each has a different constraint profile.

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Browser                                                  │
│    - Cornerstone3D (DICOM 2D/MPR/3D in WebGL)               │
│    - Three.js (IOS / 3D meshes)                             │
│    - Tools, hangs, measurements run here                    │
│    - Most of "viewing" lives at this layer                  │
└─────────────────────────────────────────────────────────────┘
                          ↓ HTTPS
┌─────────────────────────────────────────────────────────────┐
│ 2. Frontend host — Vercel                                   │
│    - Static React shell (the thing we just shipped)         │
│    - Auth proxy / signed-URL minting (light Edge functions) │
│    - Phase 1 only: also resolves patient_files via Supabase │
│    - NOT for: DICOM streaming, AI, long-running jobs        │
└─────────────────────────────────────────────────────────────┘
                          ↓ DICOMweb
┌─────────────────────────────────────────────────────────────┐
│ 3. DICOMweb gateway — Orthanc on Hetzner (or fly.io)        │
│    - WADO-RS    (retrieve studies/series/instances)         │
│    - QIDO-RS    (query studies by patient/date/modality)    │
│    - STOW-RS    (store new studies — for third-party EMRs)  │
│    - DICOM C-STORE listener (legacy modality push)          │
│    - In-RAM cache for hot studies                           │
│    - S3 plugin for blob persistence                         │
│    - Constraint: needs persistent process, fast disk, RAM   │
└─────────────────────────────────────────────────────────────┘
                          ↓ S3 protocol
┌─────────────────────────────────────────────────────────────┐
│ 4. Object storage — Cloudflare R2 (or AWS S3)               │
│    - DICOM blobs (.dcm files)                               │
│    - Petabyte scalable                                      │
│    - R2: ~$15/TB stored, free egress to Cloudflare          │
│    - Region: EU for phase 1; UAE region in phase 4 for      │
│      data-residency compliance (DHA / MOH UAE)              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 5. AI inference — Replicate (phase 2) → Hetzner GPU (4+)    │
│    - GPU-bound: cephalometric landmarks, tooth seg, caries  │
│      detection, IAN-canal seg, implant planning             │
│    - Async: client POSTs study, gets job_id, subscribes to  │
│      Supabase realtime for the result row                   │
│    - Outputs are written to imaging_annotations table       │
│    - Models stored in R2, mounted by inference VM           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Cross-cutting: Supabase (metadata + auth + realtime)        │
│    - imaging_studies, imaging_series, imaging_instances     │
│    - imaging_annotations (AI outputs + clinician notes)     │
│    - imaging_audit_log (every view/download — required for  │
│      radiology compliance)                                  │
│    - RLS policies same shape as EMR                         │
│    - Phase 1: shared with EMR; Phase 3: dedicated project   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Why Vercel is wrong for layers 3-5

### Vercel function limits that bite

| Constraint | Vercel limit | What breaks |
|---|---|---|
| Function execution time | 10s Hobby / 60s Pro | DICOM decompression of large CBCT volumes; AI inference jobs |
| Function memory | 1024 MB Hobby / 3008 MB Pro | Loading multi-frame DICOM into memory; AI model weights |
| GPU access | None | All AI inference; volume rendering pre-compute |
| Persistent process state | None (cold-start serverless) | Hot study cache; DICOM listener for modality push |
| Binary streaming | OK but not optimised | Streaming hundreds of MB pixel data per request |
| Egress cost | Pay per GB | DICOM-heavy traffic gets expensive fast |

Edge functions don't fix any of this — they're even more constrained on memory and execution time.

### What Vercel *is* right for

- The React shell (we just shipped this — correct)
- Auth callbacks
- Light API routes (mint a signed URL, return JSON metadata)
- Static asset CDN

Keep those on Vercel. Move everything else to layer 3-5.

---

## 3. Recommended stack — concrete

### Layer 3 — DICOMweb gateway

**Use Orthanc.** It's the open-source standard for self-hosted DICOM servers, BSD-licensed, has DICOMweb support built in, S3 plugin, REST API, and a community plugin ecosystem. Don't write custom code.

- **Host:** Hetzner CX31 (€10.59/mo, 4 vCPU, 8 GB RAM, 80 GB SSD) — enough for ~50 active clinics
- **Region:** EU phase 1-3; phase 4 add UAE region (Hetzner doesn't have UAE — use Equinix Metal or Oracle Cloud Frankfurt → DHA-compliant edge)
- **Storage backend:** Orthanc S3 plugin pointed at R2
- **Caching:** Orthanc's built-in study cache; tune to fit RAM budget
- **Auth:** API key per tenant + JWT validated against Supabase JWKS
- **Endpoints exposed:**
  - `GET /dicom-web/studies?...` (QIDO-RS query)
  - `GET /dicom-web/studies/{uid}/series/{uid}/instances/{uid}` (WADO-RS retrieve)
  - `POST /dicom-web/studies` (STOW-RS store)
  - `GET /dicom-web/studies/{uid}/series/{uid}/instances/{uid}/frames/{n}` (frame retrieval for streaming viewers)

Alternatives considered:
- **dcm4chee** — Java-heavy, enterprise-focused, overkill for our scale
- **dicoogle** — research-grade, less mature
- **Custom Go/Rust gateway** — too much engineering for diminishing returns

### Layer 4 — Object storage

**Cloudflare R2.** Reasons:
- Free egress to Cloudflare/Vercel (huge — DICOM is egress-heavy)
- $0.015/GB stored
- S3-compatible API (works with Orthanc S3 plugin)
- Multi-region replication (phase 4)

Buckets:
- `imaging-studies-prod` — production DICOM blobs
- `imaging-studies-staging` — staging
- `imaging-models` — AI model weights (separate so they can be rotated independently)
- `imaging-thumbnails` — pre-rendered preview images for QIDO-RS responses

### Layer 5 — AI inference

**Phase 2 — Replicate.com or Modal Labs.** Pay-per-call, no infra. Models we'd run:
- Cephalometric landmark detection (~50 keypoints) — open-source models exist
- Tooth segmentation in CBCT — research models like ToothNet
- Caries detection in periapicals — Carestream-style classifier
- Periapical pathology detection
- IAN canal segmentation

Cost: ~$0.001-0.01 per inference. AIHMC volume of ~50 studies/day with ~3 AI runs each = ~$5-50/month. Modest.

**Phase 4 — Dedicated GPU on Hetzner.** When AIHHS reaches ~10 clinics:
- **Hetzner RTX 4000 instance:** €184/month, 4 GB GPU, fine for inference (not training)
- Or **vast.ai / RunPod** spot pricing if non-real-time tolerance is acceptable
- Models loaded at startup, kept hot in GPU memory

**Async pattern (always):**
1. Frontend POSTs to imaging-api with study_id + model_id
2. Imaging-api creates `inference_jobs` row, returns `job_id`
3. Worker pulls from `inference_jobs`, runs inference
4. Worker writes result to `imaging_annotations` + updates `inference_jobs.status='complete'`
5. Frontend subscribes via Supabase realtime to that job_id row → re-renders when result lands

Don't make inference synchronous. It's slow, it fails, and you don't want the viewer hung waiting on it.

### Cross-cutting — metadata + auth

**Phase 1-2:** shared Supabase project with the EMR (`<your-supabase-project>`). Same auth, same RLS.
**Phase 3:** dedicated `aih-imaging` Supabase project. Reasons to split:
- Imaging metadata grows fast (every study = 1 row in `imaging_studies` + N in `imaging_instances`); you don't want to slow down EMR queries
- Different RLS shape (third-party EMR integrations need to write studies without EMR auth context)
- Operational separation — backups, scale, maintenance windows decouple

Cross-project auth via JWT validation. EMR mints a token, imaging-api validates it against the EMR's JWKS endpoint, and stamps a session cookie scoped to imaging.aihealth.app.

---

## 4. Phased rollout

| Phase | What lives where | When |
|---|---|---|
| **1 (now)** | Vercel shell + shared EMR Supabase. Stub viewers. | Done 2026-05-06 |
| **2** | Phase 1 + Cornerstone3D rendering + Replicate AI calls + Orthanc on Hetzner reading from EMR's existing Supabase Storage | 1-3 months |
| **3** | Phase 2 + R2 for new uploads + dedicated `aih-imaging` Supabase + DICOMweb gateway externally accessible (third-party EMRs can STOW into it) | 3-6 months |
| **4** | Phase 3 + dedicated Hetzner GPU + UAE-region edge + AIHHS imaging tier + standalone go-to-market | 6-12 months |

---

## 5. Cost shape (rough, real)

| Phase | Infra | Volume | Monthly |
|---|---|---|---|
| 1 | Vercel free + Supabase free | AIHMC only | **$0** |
| 2 | + Hetzner CX31 + Replicate (~$50) | AIHMC + 1-2 pilots | **~$70** |
| 3 | + R2 (~$15/TB) + dedicated Supabase Pro ($25) | ~5 clinics, 1 TB | **~$130** |
| 4 | + Hetzner GPU (€200) + UAE edge (~$50) | 10-20 clinics | **~$400-600** |

Compare against per-clinic licensing: at AED 800-1500/month per clinic, even phase 4 break-even is ~3 paid clinics. The infra is not the gate — the regulatory + go-to-market work is.

---

## 6. Data-residency note (UAE)

DHA (Dubai Health Authority) and MOH UAE have data-localisation guidance for patient PHI. By phase 4 — when we sell to non-AIHMC clinics — there's a real likelihood we'll need patient data stored in a UAE region.

Options:
- **Oracle Cloud Frankfurt** — has UAE-region availability with DHA-compliant attestations
- **Equinix Metal Dubai** — bare metal, expensive but direct
- **AWS Bahrain (me-south-1)** — closest hyperscaler region, GCC-friendly
- **G42 Cloud** — UAE national champion, expensive but politically aligned

For phase 1-3 we're EU/Hetzner; for phase 4 we evaluate based on first paying tenant's contract requirements. Don't pre-build for compliance you don't yet have a buyer for.

---

## 7. Out of scope (explicitly)

- ❌ Build a custom DICOM parser — use cornerstone-dicom-image-loader
- ❌ Build a custom DICOM gateway — use Orthanc
- ❌ Train AI models in-house — partner with model providers, integrate via API
- ❌ Run training on Vercel/Hetzner CPU — training needs A100s, rent or partner
- ❌ Synchronous AI calls from frontend — always async
- ❌ Self-hosted Postgres — Supabase until scale forces a move

---

## 8. Decisions still open for Dr Ahmed

1. **First non-AIHMC pilot** — confirms region/residency requirements, drives phase 4 timing
2. **Build vs buy AI model:** partner with an established cephalometric / dental AI vendor (Pearl, Overjet, Diagnocat) for white-label vs use open-source models. Both have downsides.
3. **GPU class for phase 4** — RTX 4000 is enough for ~10 clinics; A100 needed for hospital-scale. Decide based on actual volume.
4. **Dataset rights** — if AIHMC's anonymised CBCT data trains improvements to models, who owns the resulting model? Important to set this up cleanly before any data leaves AIHMC.
