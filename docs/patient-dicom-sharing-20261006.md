# Patient DICOM sharing and series browsing

This draft pairs with clinic PR [#993](https://github.com/drahmedaboufoul/aihealth-medical-center-billing/pull/993). It does not ingest, release or modify a patient's images. No production migration, deployment or release was performed for this change.

## Release dependency

The clinic acquisition metadata and patient-external intake migrations must be reviewed and applied first, in timestamp order (072718, 073147, 073720). They provide `dicom_acquisition`, explicit `filing_scope`, the completed external intake audit, and the scope-aware source-artifact RPC. Deploying this resolver before those columns/functions exist fails closed. The clinic and viewer releases require coordinated clinical review before patient visibility is enabled.

## Authorization

The resolver now checks invitation/study clinic equality, active clinic and live study, current patient visibility for `source=patient`, and database-authorized source artifacts. Explicit recipient/clinician invitations retain their separate authorization; patient visibility is not required for those invitations.

For non-CBCT sources the exact file, artifact, patient, clinic, encounter/scope, storage path, bucket and SHA-256 must agree. A null encounter is accepted only for an explicit patient-external study with a complete matching intake session. Missing, extra or duplicate source identities fail closed. CBCT retains the database-selected diagnostic series and derived NIfTI provenance guards.

View reservation binds both the old view count and maximum count and requires a live invitation. Lifecycle and patient release are checked before and after signing. Source artifact identities are rechecked after signing. Every file must receive a matching signed path; partial or substituted signing responses are rejected. Artifact lookup and storage signing use batches of at most 100 paths/IDs (317 instances require four storage calls, not 317).

Signed URLs expire after ten minutes. Revocation prevents subsequent grants and a concurrent revocation prevents this endpoint from returning already-minted grants. It cannot invalidate a previously delivered signed URL before expiry or erase images already loaded by the recipient. The client rejects expired cached grants on reopening; a random per-resolution session key is removed on navigation. Patient DICOM views do not automatically join clinician realtime rooms.

## Display

All authorized raw DICOM series remain selectable. Series are sorted by source series number, with distinct sequential labels even when descriptions repeat. Within a series, consistent single-frame geometry determines order along the image normal; otherwise the UI names the instance-number/filename fallback. Multi-frame instances expand into one-based Cornerstone frame IDs. Instance and frame counts are distinguished.

Source pixels, modality rescaling, source VOI and presentation remain with Cornerstone; this change adds no enhancement or contrast algorithm. Switching series resets the viewport and disposes the previous rendering engine/listeners. Window slider bounds retain source values beyond the former fixed range, and the slice control displays one-based positions. These are viewing controls, not evidence of improved diagnostic quality.

## Validation and limits

- `npm test -- --maxWorkers=2`: 221 tests in 18 files passed, including 317 synthetic instances, patient release/revoke races, manifest mismatch, CBCT selection, batch signing, frame expansion, geometry, duplicate descriptions and cached access expiry.
- `npm run test:e2e`: all four browser tests passed. A generated three-instance DICOM stack exercises the real Radix slider and Cornerstone viewer: Home then Right advances from slice 1 to 2; window and series controls retain keyboard ownership. Restoring the old global handler makes this regression fail with slice 3, confirming it detects the reported bug. Sliders expose their actual semantic labels.
- `npm run build`: passed using synthetic loopback public client configuration. Existing large-chunk, codec browser-externalization and mixed-loader warnings remain.
- `npx tsc --noEmit`: fails with 14 unresolved import errors in untouched IOS components (`@/types`, `@/data/mockData`, UI modules and three loader declarations). The project does not currently provide a typecheck script. This draft does not claim a clean full typecheck.

Full viewer access still requires a viewport at least 1024 pixels wide. Patient portal previews are a separate clinic feature; mobile full-viewer support was not validated. Legacy records without acquisition metadata remain one frame per file. Enhanced per-frame geometry, all transfer syntaxes, DICOMDIR reference traversal, and universal DICOM support are not certified by these tests. A manifest exceeding the server's configured source-row response limit is rejected as incomplete rather than partially shown. Live authentication, end-to-end patient release and clinical interpretation require release verification with authorized staff; synthetic tests do not substitute for that gate.


The deflated dataset correction installs dicom-parser's documented browser pako
inflater only if absent, using the existing declared pako dependency. Cornerstone
wadouri does not forward an explicit parser callback. Newly installed inflation
is bounded to 256 MiB per dataset; malformed/truncated data fails closed. The
browser regression generates both native and deflated DICOM, checks rendering and
single-step keyboard navigation, and fails for the deflated case when the installer
is removed. Clinic ingestion uses the same helper through an explicit callback,
so it does not depend on opening a viewer first. This does not certify other
compressed syntaxes or change source pixels/presentation.
