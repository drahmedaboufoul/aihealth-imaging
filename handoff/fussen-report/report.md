# Fussen DentalX AI — feature-capture report

**Platform:** DentalX AI cloud (`ai.dentalx.com/eur/`)
**Account:** owner's own (Dr Ahmed Abou Foul team space)
**Walkthrough date:** 2026-07-12
**Purpose:** blueprint for natively replicating DentalX's files/communication model, 2D viewer, CBCT viewer, IOS viewer, and AI/reporting features in the kyour ecosystem. Functionality and interaction patterns only — no code/assets/branding copied.

> **Screenshot note:** this walkthrough was driven through the Claude-in-Chrome extension, which in this session did **not** persist screenshots to disk. The report is therefore written to be exhaustive enough to rebuild behavior without images — every toolbar, dialog, field, dropdown option and interaction observed is transcribed below. Where a screenshot would normally be referenced, the `shots/` column says `(described inline)`. If images are needed, the same walkthrough can be re-run with a persistence-capable capture path.

---

## 1. Executive summary

DentalX AI is a **Chinese-built (Sichuan ICP filing), multi-region, cloud dental-imaging + AI-ordering platform** wrapped around a patient-centric data store. The main app is a hash-routed SPA at `ai.dentalx.com/eur/`; the heavy 3D/2D viewers are **separate WebGL applications** served from `eurs.dentalx.com` (numeric-prefixed GPU instances) and a CDN host `eurc.dentalx.com`, opened in new browser tabs and authenticated by short-lived tokens + a `dx2token` JWT passed in the URL.

**Object model:** `Team (clinic space) → Patient → Data item (per modality) → AI/Lab Order`. There is **no explicit "case" or "study" layer** in the UI — data items (CT, IOS, CR, pano, ceph, face scan) attach directly to a patient, and orders reference selected data items. A parallel **Personal Space** exists alongside the team space; storage and data are partitioned per space.

**The five things it does best:**
1. A genuinely broad **AI analytics stack on CBCT** — per-tooth segmentation, jaw/sinus/nerve/NPC auto-segmentation, per-tooth pathology findings (e.g. "SecondaryCaries") surfaced on an FDI wheel, auto-pano curve, TMJ dual-condyle auto-views, airway preset, root-canal measurement, and a one-click study-report builder.
2. A **very deep implant-planning surface**: ~100-brand implant library with series → platform/diameter × length matrix, safety-margin slider, nerve-collision context, virtual extraction, multiple alternative plans per case, plus an online-auto vs desktop-manual surgical-guide fork.
3. **Live collaborative viewing rooms** (room-id invite links with operator/participant roles and configurable expiry + anonymization) rather than static share links.
4. A **structured lab-order/case-submission workflow** (Orthodontics / Prosthodontics / Implant) with rich clinical parameter forms (restoration types, VITA shades, materials, appliances) that route to a partner-lab network.
5. **Scanner-cloud integrations** (SHINING 3D, MEDIT) that pull IOS data directly from vendor clouds, plus device/manual data provenance tracking.

**Five things that feel weak / missing (vs. what we'd want):**
1. **No per-case asynchronous communication** — no comment threads, @mentions, or chat feed on a case; collaboration is live-room co-viewing + email notifications only.
2. **No patient-facing sharing** — no "send to patient", no patient portal link, no patient PDF delivery (report is Print-to-paper only).
3. **Flat data organization** — no folders, tags, archive, or visit/timeline grouping; each patient is just two flat lists (Data / Orders).
4. **Heavy, monolithic viewers** — a single-volume download model with WebGL that freezes the main thread for tens of seconds on tab switches, plus an idle "sleep mode" that forces a full reload; no evidence of progressive slice streaming.
5. **Entitlement/credit gating woven through** — AI orders consume "Credits"; some features are download-a-desktop-app gated (surgical guide design, DICOM upload tool); storage upsell ("View Benefits"); some AI buttons produced no visible output without a job/entitlement.

---

## 2. Object & data model (as observed)

| Entity | Notes |
|---|---|
| **Space** | `Personal Space` and one or more `Team` spaces (e.g. "DR AHMED ABOU FOUL"). Data + storage partitioned per space (Storage page shows "Personal space: 0B, Clinic space: 180.68M"). Switched from the avatar menu → Current Space. |
| **Team** | Clinic entity. Has: members (roles Creator/Member), team wallet (Credits), partners (labs), team address, report-branding settings. Managed at `#/groupDetail`. |
| **Patient** | **Primary object.** Fields: First Name*, Last Name, Gender* (Male/Female/Other), Patient ID (optional; auto-generated e.g. `FS2607128483`, `DX20260711JRAW`), Age, Birthday. 450–460 patients in this account. |
| **Data item** | A single acquisition, typed by modality. Types: **IOS, CT (=CBCT), Face Scan, Panoramic, Cephalometric, CR** (2D radiographs incl. periapical). Each carries: Data No. (e.g. `CT20260711MXAI`, `IOS20260711MXNT`), Create Time, Data Type, **Source** (`Manual` or `Device`), editable Remark, and modality metadata (see below). |
| **CT metadata** | Manufacturer (e.g. `iRYS`), Acquisition Time, FOV (e.g. `13.20 × 10.29 cm`), Voxel Size (`0.30 mm`), Voltage kV (90), Current mA (4), Dose (`3.00 dGy·cm²`), File Size (`127.47 MB`). |
| **AI Order** | Per-module order (AI Implant Planning, AI Model Builder, AI Crown, Multi-Data Fusion, 3D DSD, Orthodontic Simulation, AI Periodontal Analysis). Lifecycle: create → (auto) design → `Design Completed` / `Design Failed` → paid → downloadable. Consumes Credits. |
| **Lab Order (Dental Clinic Order)** | Case submission to a partner lab. Type ∈ {Orthodontics, Prosthodontics, Implant}. Auto-classified Data Type shown in list. Status e.g. `Not Ordered`. |
| **Live room** | Ephemeral collaboration session (`Room ID`, validity in Hours/Days/Months, operator + participant roles, optional anonymized patient info). |

**Statuses observed:** AI order `Design Completed` (green) / `Design Failed` (red, with remark e.g. "Sleeve design failed, please design manually"); payment remark "The order has been paid"; lab order `Not Ordered`; per-tooth AI flag (red tooth on FDI wheel = finding present).

---

## 3. Files & communication model (TOP PRIORITY)

### 3.1 Shell & navigation
- **Login** (`#/login`): "Password Login" / "Code Login" (email OTP) tabs; Account, Password, Remember password, Forgot password, Register now. Language switcher (globe). Support chat bubble (headset) bottom-right. Lands on `#/home`.
- **Top bar (home):** logo · storage pill (`180.69M/100G`, click → Account Center/Storage) · upload-queue cloud icon (panel "Upload Task (0)") · help `?` · **notification bell** (Unread/All tabs; "No more messages") · language globe · **avatar menu**.
- **Avatar menu:** *Current Space* (Personal Space / team / + New Team); *Quick Operations* (Team Settings, Account Center, Account Wallet, Data Cloud Platform, Customize Home, General Settings, Logout).
- **Home dashboard** = rearrangeable widget grid (edit via "Customize" button): profile card, **Patient Management** (recent patients), an **app launcher grid**, **AI Viewer** (recent data, items tagged e.g. `CR`), and one card per order module (AI Implant Planning, Dental Clinic Orders, Multi-Data Fusion, 3D DSD, AI Crown, AI Model Builder, Orthodontic Simulation, AI Periodontal Analysis), each with a `+` to create that order type directly.

### 3.2 Patient list & case/file management (`#/patientManage`)
- **Left = patient list.** Row: avatar, name, ID, gender icon (blue male / red female), age if DOB set. Hover reveals: details/copy, edit, delete. Top: search ("Patient name / Patient ID / Case number"), sort dropdown, date-range + calendar, blue **add-patient** button.
- **Center = two tabs: `Data List` / `Order List`.**
  - **Data List:** modality filter chips `All / IOS / CT / Face Scan / Panoramic / Cephalometric / CR`. Grid view: colour-coded modality tag (CT blue, IOS green, CR red), thumbnail, "Create Time", selection checkbox. Hover a card → open/play button + **Details / Download / Delete** (tooltips confirmed). **No share action at the data-item level.** Grid↔List toggle top-right. **List view** columns: Data No., Create Time, Data Type, **Source** (`Manual`), Remark, Actions (eye=open viewer, details, download, delete); adds batch-download + select-all in list mode. First tile is always **Upload**.
  - **Order List:** columns Patient Info, Sites, Update Time, Type, Status, Remarks, Actions (empty for patients with no orders).
- **Details dialog** ("Data List"): patient header, Data No., Create Time, DICOM metadata (Manufacturer, Acquisition Time, FOV, Voxel Size), editable Remark notes box.
- **Right rail "Digital Application":** contextual launchers (AI Implant, AI Model, AI Crown, Multi-Data, 3D DSD, Ortho, AI Perio) — enabled/greyed by whether the selected patient has the required data type (CT for implant, IOS for model/crown, etc.).

### 3.3 Upload / import (Add Data dialog, from the Upload tile)
Modality tabs: **IOS | CT | Face Scan | Panoramic | Cephalometric | CR.**
- **IOS:** sub-tabs `Upload` / `SHINING 3D` / `MEDIT`. Upload = tiles *Upper Jaw / Lower Jaw / + Add*. Vendor sub-tabs open a picker table (Upload-time range, Patient name, Institution, Data Sites, Actions) pulling from the vendor cloud; if no account is bound → Note dialog *"You do not have an account associated with this platform. Please first go to the Data Cloud Platform to associate an account"* with a **[Go to Data Cloud Platform]** button.
- **CT:** drag-drop a **DICOM folder**; note *"Only one data per patient can be uploaded at a time… Missing files may affect the diagnosis"* + downloadable desktop **Upload Tool** (Windows 32/64-bit).
- **Face Scan:** tiles *Face Smile Data / Standard Face Data / Retracted Smile Data*.
- **Panoramic / Cephalometric / CR:** drag-drop `DICOM / JPG / PNG / TIF / BMP`, Ctrl-multiselect, same Upload-Tool links.
- **Add Patient dialog:** First Name*, Last Name, Gender* (M/F/Other), Patient ID (optional), Age, Birthday. Toast "New patient added successfully".

### 3.4 Storage / quota (Account Center → Storage Management)
- My Cloud Storage: Total 100 G / Used 180.68 M / Remaining 99.82 G + **"View Benefits"** upsell.
- Usage bar split Personal / Clinic / Remaining. **Storage Distribution** filter (All Spaces / Personal Only / Clinic Only) + donut by modality: CBCT 70.55 %, CR 14.88 %, IOS 14.57 %.
- Account Center also has **Account Security** (masked email binding, change login password) and **Activation Records** (membership/license activation history table: Order ID, Activation Time, Type, Status).
- **No folders / tags / archive** anywhere.

### 3.5 Communication
- **Live viewing rooms** are the collaboration primitive (see §4). No per-case chat thread, @mentions, or comment feed. **No patient-facing sharing** (no "send to patient", no patient PDF export; report is Print only). Notifications = in-app bell + email (lab-order "Email Lab Manager").

---

## 4. Sharing — the exact recipient experience (TOP PRIORITY — drives `imaging_share_invites`)

Sharing is initiated **from inside a viewer** (CT viewer top-right funnel/menu icon), not from the patient list.

**Menu:** `Invite` · `Prolong time` (extend an active session).

**Invite dialog fields:**
- `Room ID` (e.g. `192463`).
- `Valid period`: a number × unit toggle **Hour / Day / Month**, with the computed absolute expiry shown alongside (e.g. "2026-07-12 23:37").
- `Link`: `https://ai.dentalx.com/eur/#/link?id=192463`.
- `Theme`: editable label, defaults to `<doctor name>invitation`.
- Checkbox **`Anonymous patient information`** (PHI masking for the recipient).
- Buttons: **[Copy all information]** · **[Copy Link]**.

**Recipient experience (opened the link in-session):**
- `/eur/#/link?id=…` **redirects into the full CT viewer** (the "earth" app), joined to a **live room**. The viewer header changes to show `192463 (1Person) ▾  Operator: Dr…` — i.e. **participant count + an operator/participant role model** (implying control hand-off).
- The recipient gets the **full viewer**: all workspace tabs (MPR, 3D PANO, Implant, TMJ, Cephalometric, Compare, Gallery), all AI-analytics objects, all measurement tools, the gallery. **No view-only restriction, no watermark, no branding overlay, no signup/"request access" nudge** was observed for an in-org recipient.
- Idle behavior: a **"The system goes to sleep mode…"** dialog appears after inactivity (**[Stop sleep mode]** / **[Close]**); resuming reloads the viewer and re-downloads the volume with a `%` progress ring.

**Architecture read:** share = **room-id based** (the room id is the `#/link?id=` param), operator/participant → websocket state sync (not packet-inspected). Contrast with our tokenized static-link model: DentalX's is a *live co-viewing session* with expiry + optional anonymization, not a read-only snapshot.

---

## 5. Lab orders / case submission (TOP PRIORITY)

Two distinct order surfaces exist: **AI order modules** (design services, §7) and **Dental Clinic Orders** (send a case to a lab). Both share an identical 3-step wizard shell.

### 5.1 Dental Clinic Orders (`#/clinicSend/orderList`)
- **Data List:** Patient Info, Create Time, **Data Type** (auto-classified `Orthodontics / Prosthodontics / Implant`), Source (`Manual`/`Device`), **Order Status** (`Not Ordered`…), Actions (+ order, details). 355 records.
- **Create Order wizard:**
  - **Step 1 — Patient & data:** patient name/gender + required data slots (IOS* + an "Add Photos" slot); data-source tabs (Dental X / SHINING 3D / MEDIT / +); pick or upload.
  - **Step 2 — Order Type + Parameter Settings:** a jaw/tooth selector (Upper Jaw / Lower Jaw buttons; **US ↔ FDI** tooth-numbering toggle) plus per-type parameter blocks:
    - **Orthodontics → Appliance:** Diagnostic Model, Retainer, Clear Aligner, Bite Splint, Night Guard, Sports Mouth Guard, Anti-Snoring Appliance, Bleaching Tray, Bracket Bonding Guide, Removable Appliance.
    - **Prosthodontics → Restoration Type:** Crown, Inlay/Onlay, Veneer, Post & Crown, Partial Denture, Diagnostic Wax-up, Pontic, Full Denture, Custom Tray. **Tooth Shade:** VITA Classical system (dropdown) — 0M1/0M2/0M3, A1–A4, B1–B4, C1–C4, D2–D4. **Material:** Zirconia, Glass Ceramic, Pressed Ceramic, Emax, Hybrid Ceramic, Non-precious Metal, …
    - **Implant → Implant Type:** Radiographic Guide, Surgical Guide, Conventional Implant Restoration, Edentulous Implant Restoration. + Tooth Shade + **Material:** Zirconia, Glass Ceramic, Hybrid Ceramic, Precious Metal, Non-precious Metal, 3D Print, PMMA.
  - **Step 3 — Send (final review):** **`Select Dental Lab`** ("Please Select the Partners" dropdown, populated from the Partners network; "No data" if none bound), **Notification** ☑ `Email Lab Manager`, **Shipping Information** (`Urgent` toggle + Add Address), **Remarks** (0/200). **Confirm = send.**
- **Stopped at the Step-3 review** per instructions (no lab selected → validation error "Please Select the Partners"; exit-guard dialog *"Order Not Sent — will not be saved if you exit"*). Nothing submitted.
- **Terminology:** orders are **"sent"** to labs; labs are **"Partners"**; two-way delivery/messaging on an order was not reachable without an active partner + submitted order.

---

## 6. CBCT viewer — feature checklist (TOP PRIORITY)

The CBCT viewer is the **"earth" app** (`eurs.dentalx.com/<n>/earth/lookover?…`), opened in a new tab, titled `CT Viewer-<patient>`. It **remembers the last workspace** (re-opened directly into Implant). Top bar workspace tabs: **MPR · 3D PANO · Implant · TMJ · Cephalometric · Compare · Gallery**; right side: doctor name, **funnel/Invite menu**, signal/quality icon, fullscreen, close.

**Persistent left sidebar (varies per workspace):** `MPR view` (Preset W/L dropdown + brightness/contrast/2 more sliders, reset, edit) · `3D view` (preset dropdown, 3 sliders) · `ROI` · `Analyze` (AI/tool icon grid) · `Tool` (measurement palette) · `Objects` (dropdown-switched object panels) · `More` (snapshot / report / image-info) · `Gallery (N)`.

**Per-pane header (every 2D pane):** camera-snapshot · expand-pane · crosshair toggle · render-mode dropdown **AVG / MIP** (pano also **VR**) · slab-thickness dropdown · download (pano). Pane corners carry orientation letters (A/P/R/L/H/F), an mm position readout, `ZOOM:x.xx`, and a cm scale bar.

| Feature | Present? | How it works | Shortcut / mouse | Shot |
|---|---|---|---|---|
| Default layout | Yes | 2×2 MPR (axial/coronal/sagittal + 3D) in MPR; other workspaces reflow (e.g. Implant = 3D + pano + axial + 2 cross-sections). | crosshair sync across panes | (described inline) |
| Layout / fullscreen-one-pane | Yes | Per-pane expand icon; TMJ offers `1×1 / 1×3` layout selector. | pane header | — |
| Window / level presets | Yes | `Preset` dropdown + 4 sliders (brightness 59, contrast 75, +2). 3D-view preset list: **Tooth / Bone / Soft tissue / Gray scale display / Airway analysis** (Surface/Perspective appear in tooth-focus). | sliders | — |
| Zoom / pan / scroll-slice | Yes | Per-pane; ZOOM readout; scroll steps slices. | wheel = slice; drag = pan (default scheme configurable, see §9) | — |
| Slab thickness / MIP | Yes | Per-pane thickness dropdown (0.30 → ~50–103 mm; pano default 17.54 mm) + AVG/MIP/VR mode. | dropdowns | — |
| Orientation markers | Yes | A/P/R/L/H/F on pane edges + cm scale bars. | — | — |
| Measurements | Yes | Tool palette: length ("8mm" line), polyline/curve, angle, text/label (IaA), nerve/mandible tool, image-compare, undo/reset; magnifier zoom. | click tool then draw | — |
| HU probe / bone density | Yes | Objects → **Bone density** panel; Implant cross-sections show density context. | — | — |
| **Panoramic / curve mode (3D PANO)** | Yes | Axial pane shows a **red arch curve (auto-generated, editable)**; reformatted pano pane with FDI tooth-number buttons above/below (lesion teeth highlighted dark red); 3D pane with red ROI box; **3 perpendicular cross-section panes** with mm position readouts; Analyze offers *arch+AI (auto curve)* and *manual arch*. | scroll cross-sections to step positions | — |
| Ceph mode | Yes | Generates **Lateral + Anterior (PA)** projections side-by-side; 3 projection-style thumbnails; "Ceph position" panel (degree dropdown, tilt-left/right, arrow nudges, reset); per-pane download; single **AI auto-tracing** button (produced no visible output this session — likely job/entitlement). | — | — |
| **Implant planning** | Yes | Objects → **Implant&Restoration**: plan `case1` (rename/delete), implants listed `25 / 45 / 47 | NEODENT…` each copy/edit/delete; **+ Add new plan** = alternative plans. Cross-sections render implant (green outline/yellow body + tooth-number label) with **red/green distance dots to danger structures**. | edit implant → Implant Bank | — |
| Implant library (Implant Bank) | Yes | `Brand` dropdown = Recent + **"All brands"** searchable A–Z grid (~100+: 3DCelo, 3DDX, 3Diemme, 8plant, AB Dental, Adin, Alfa Gate, Alliance, Alpha Dent, Alpha-Bio Tec, Ankylos, Anthogyr, Antmed, Argon, Astra Tech, Avinent, B&B Dental, BEGO, Bicon, BIO-CONCEPT … Straumann, Sweden&Martina, THOMMEN, TRI, Zimmer Dental, ZUGA …). `Series` dropdown (e.g. GM HELIX ACQUA). **Platform/Diameter × Length matrix** picker (Ø3.5–7.0 × L8.0–18.0) with implant glyphs, 3D preview, summary (FDI position, Brand, Series, Model #, Length, Diameter), **`Safe area` slider (default 1.5 mm safety margin)**, and an FDI **Tooth Chart** with "Virtual tooth extraction" (orange) / "Missing tooth" (red) markers. | Confirm/Cancel | — |
| Virtual tooth extraction | Yes | Analyze box-X icon → "Tooth extraction" dialog: pick teeth on FDI chart to virtually extract. | — | — |
| **Nerve canal** | Yes | AI object **Neural tube ×2** (left/right) with lock/edit/delete; rendered red across pano + cross-sections; manual nerve tool + auto-nerve arch (greyed until run). Implant cross-sections show collision/distance cues. | — | — |
| **AI: tooth segmentation** | Yes | Objects → **AI analytics (9)**: toggling **Teeth** paints **per-tooth coloured segmentation across all panes** (3D, pano, axial, cross-sections). | eye toggles per object | — |
| AI: jaws / sinuses / NPC | Yes | Objects: Upper jaw, Lower jaw, left/right maxillary sinus, NPC — each a coloured region overlay w/ visibility toggle. | — | — |
| AI: per-tooth pathology (MPR) | Yes | MPR Analyze shows an **FDI "Please choose tooth position" wheel**; teeth with findings are **red** (e.g. 47, 36). Selecting a flagged tooth recenters/zooms all panes, shows the finding label (**"SecondaryCaries"**), outlines+hatches the lesion in slices, and turns the bottom-right pane into an **isolated 3D tooth mesh** (3D preset → Surface). | click tooth on wheel | — |
| AI: root-canal measurement | Yes | On a selected tooth, per-root buttons appear (**MB / MP / D**, colour-coded); clicking MB renders the tooth translucent with the root-canal system highlighted orange (preset → Perspective). | click root button | — |
| AI: airway | Yes | 3D-view preset **"Airway analysis"** (volume/segmentation). | preset dropdown | — |
| **TMJ auto-views** | Yes | Dual-condyle workspace: L/R condyle sagittals + axial with draggable per-condyle axis lines; a row of serial condyle cross-sections (`1×1 / 1×3`) + two boxed 3D condyle renders; condyles AI-segmented green. | drag axis lines | — |
| 3D volume rendering | Yes | Presets Tooth / Bone / Soft tissue / Gray-scale / (Airway); segmentation-coloured view when AI objects on; clipping via ROI box. | — | — |
| **Compare (CBCT↔CBCT)** | Yes (needs ≥2 CTs) | `Compare` → **"Import CT"** dialog listing the patient's other CT studies (ID, Name, Accession, Doctor, Study Time); "No data" for single-CT patients. Compare workspace has per-view **date/timepoint dropdowns** + layout modes (2×2 grid / columns / 3D). | — | — |
| CT + IOS overlay/registration | Partial | Not inside this viewer — lives in the separate **Multi-Data Fusion** module (order-based; not opened to avoid creating an order). | — | — |
| Export / output | Partial | Per-pane snapshot → **Gallery**; pano/ceph per-pane **download**; **report builder** (below). No DICOM/STL export surfaced from the viewer this session. | — | — |
| **Reporting** | Yes | `More` → report-edit → **"Edit" CBCT study report builder**: title; auto patient header (Accession, Name/Number/Sex/Age); image size **Small/Medium/Large**; **"Image Performance"** = 3 image slots fed from Gallery snapshots; **Image Description** textarea; **Diagnosis Note** textarea; Doctor; Date; Doctor address; Contact. Buttons **Save / Generate report / Report / Close**. *Generate report* → print-style preview page ("CBCT study report") with **Print / Exit Preview**. | — | — |
| Image info | Yes | `More` → info icon → editable patient fields + kV 90 / mA 4 / FOV / Dose 3.00 dGy·cm² / Acquisition Time / File Size 127.47 MB. | — | — |

---

## 7. AI features summary (TOP PRIORITY)

| AI feature | Trigger | Runtime (observed) | Output | Editable? | Quality impression |
|---|---|---|---|---|---|
| CBCT tooth segmentation | Objects → AI analytics → toggle `Teeth` | pre-computed (instant toggle) | Per-tooth coloured mesh across all panes | Visibility toggle; lock/edit on nerve objects | Clean, per-tooth isolatable |
| Jaw / sinus / NPC segmentation | AI analytics object toggles | pre-computed | Coloured region overlays (upper/lower jaw, L/R sinus, NPC) | Toggle | Consistent across views |
| Nerve (neural tube) auto-map | AI analytics `Neural tube ×2` (or manual/auto-arch tool) | pre-computed | Red canal path in pano + cross-sections; implant collision cues | Lock / edit / delete per side | Good; drives implant safety |
| Per-tooth pathology findings | MPR FDI wheel (red teeth) → select tooth | pre-computed | Finding label (e.g. "SecondaryCaries"), lesion outline+hatch, isolated 3D tooth | Review by selecting teeth | Surfaces findings tooth-by-tooth; usefulness = the delta vs our stubbed AI |
| Root-canal measurement | Select tooth → MB/MP/D root buttons | interactive | Translucent tooth w/ highlighted canal system | Per-root | Endo-oriented; not in our stack |
| Auto-pano (arch curve) | 3D PANO workspace, arch+AI Analyze | auto on load | Auto-generated editable red arch → reformatted pano + cross-sections | Curve editable | Comparable to our manual reformat but auto |
| TMJ auto dual-condyle | TMJ workspace | auto on load | Segmented condyles + serial sections + 3D renders | Axis lines draggable | Matches our TMJ dual-condyle mode |
| Airway analysis | 3D-view preset "Airway analysis" | preset | Airway-focused volume | — | Preset-level (didn't confirm volume/min-CSA numbers) |
| CBCT report generation | More → report → Generate | instant | Print-style study report w/ snapshots + notes | Fully editable pre-generate | Templated, print-only |
| **2D CR AI diagnosis** | CR viewer → Diagnosis → AI | ~5–10 s | **Ranked findings w/ confidence** + numbered bounding boxes on image (e.g. `1. Pulpitis 64.6%`, `2. Pulpitis 52.5%`, `3. Periodontitis 41.0%`, `4. Periodontitis 30.6%`, `5. Furcation involvement 25.7%`) | Review only observed | Genuine 2D pathology detection — a clear delta vs our zoom/pan-only 2D viewer |
| Ceph auto-tracing | Cephalometric → AI | no visible output this session | (expected tracing/analyses) | — | Unconfirmed — likely job/entitlement gated |
| IOS occlusal-contact / undercut / AI seg | Model viewer tools | interactive / job | Occlusal distance colour map; undercut detection; AI segmentation (no visible immediate effect) | — | Contact map works; AI seg likely needs processing |

### AI order modules (design services)
Launched by selecting eligible data in Patient Management → active Digital-Application icon → new tab. Pattern (identical across modules, detailed for **AI Implant Planning**, `#/implantPlan/orderList`):
- Left nav **Data List / Order List / Preference Settings** + **"Install Dental X Guide"** (desktop surgical-guide app).
- **Data List:** all eligible data (641 records, 43 pages) — Patient Info, Create Time, Data Type, Source, Actions.
- **Create Order wizard:** Step 1 patient + required data slots (**IOS\*** + **CT\***) + data-source tabs. Step 2 **design-software fork** — *"AI Implant Studio — Online Automatic Guide Design; Simple cases (1–3 missing teeth); AI Assistant: Supported; Install: Not Required"* vs *"Dental X Guide — Desktop Manual Guide Design; Complex cases; AI Assistant: Not Supported; requires download+activation"*. Step 3 Design Type (`Implant Guide` / `Implant Planning`), **Surgical-guide settings** (plate thickness 3.0 mm, model offset compensation 0.03 mm, guide sleeve offset 0.03 mm), **Case Setup** FDI chart with Crown/Implant paint modes. **Confirm = submit** (stopped here; exit-guard "Order Not Designed — will not be saved").
- **Order List:** Patient, **Tooth Number** (mini FDI diagram), Update Time, **Design Tool** ("WEB Design"), Design Type, **Status** (`Design Completed`/`Design Failed`), Remarks ("Sleeve design failed, please design manually" / "The order has been paid"), Actions (edit/view/download). 18 orders.
- **Preference Settings:** default design params (same 3 sliders) applied to new auto-design orders.
- **Billing:** Team Wallet shows **Credits**; Team Bill logs entries like "AI Implant PlanningOrder", "AI Model BuilderOrder" (0 Credits here). AI orders are **credit-metered**.

---

## 8. 2D image viewer — feature checklist (HIGH)

The 2D/CR viewer is the **"saturn" app** (`eurs.dentalx.com/<n>/saturn/#/crpc`), new tab `CR Viewer-<patient>`; URL carries DICOM `studyuid/seriesuid/sopuid`, `kindid=54`. Dark theme; single image; mm ruler on the right edge; `W:… / L:…` readout + acquisition timestamp.

| Feature | Present? | How it works | Shot |
|---|---|---|---|
| Handles | CR / periapical / bitewing (and pano/ceph via their own DICOM/JPG intake) | (opened a periapical) | (described inline) |
| Pan / move | Yes | move tool | — |
| Zoom / region-magnify | Yes | magnifier tool | — |
| Window/level, brightness | Yes | dedicated W/L + brightness tools | — |
| Invert / negative | Yes | invert-diagonal + negative tools | — |
| Rotate / flip / skew | Yes | rotate 90°, R-rotate, flip horizontal, skew tools | — |
| Crop / fit | Yes | crop + fit-to-window | — |
| Enhancement / filters | Yes | enhancement tool + **two pseudo-colour maps** | — |
| Measurements | Yes | `8.0mm` line, `8.0mm` polyline, angle, perpendicular, oval mask/slash, text (IaA) | — |
| Annotations | Yes | text label; drawn shapes; delete (X) | — |
| Compare side-by-side | Not observed in this viewer | — | — |
| Thumbnails / filmstrip | Not observed (single-image view) | — | — |
| Print / export | Yes | `More`: display-info overlay, save, export image, delete | — |
| **2D AI** | Yes | `Diagnosis → AI` → ranked findings + confidence + bounding boxes (see §7). Auto tooth-numbering/caries surfaced as the finding list. | — |

---

## 9. IOS / 3D mesh viewer — feature checklist (MEDIUM)

The IOS viewer is the **"queenbee" app** (`eurc.dentalx.com/bird/queenbee/`, on the CDN host), new tab `Model Viewer-<patient>`; URL params `kindid=41`, `ossType=OSS` (Alibaba OSS storage), `language`, `mousesetting`, `openai=1`, `emrtype=100`. White theme.

| Feature | Present? | How it works | Shot |
|---|---|---|---|
| Roles / arches | Yes | `Maxilla` / `Mandible` rows in right panel, each with visibility eye + **opacity slider**. Bite shown occluded. | (described inline) |
| Measurement | Yes | left **Measurement** tool | — |
| **Occlusal contact map** | Yes | **Occlusal Contact** tool → rainbow distance scale `-0.40 → 1.20 mm` colour bar overlaid = occlusal clearance/contact map | — |
| Undercut detection | Yes | **Undercut Detection** tool | — |
| AI segmentation | Present but no visible effect | **AI** button (openai=1); likely needs processing/entitlement | — |
| Orientation presets | Yes | right-edge view-cube (~6 preset views) | — |
| Colour / texture | Yes | **Color Switch** (true-colour ↔ mono), grid/matrix toggle | — |
| Margin / prep tools | Not present in this viewer | — | — |
| Compare over time | Not present in this viewer | — | — |
| Alignment with CBCT | Elsewhere | via Multi-Data Fusion module (order-based) | — |

---

## 10. Interaction reference (mouse + keyboard)

- **Global 3D mouse scheme** (General Settings → Mouse operation settings, applied uniformly to *all* 3D tools — AI Implant Planning, AI Model Builder, AI Crown, Multi-Data Fusion, 3D-DSD, Face Scan Viewer, Intraoral Scan Viewer, Orthodontic Simulation): two selectable schemes —
  - **A:** Left-click rotate / Right-click select.
  - **B:** Right-click rotate / Left-click select *(active in this account; `mousesetting=2`)*.
- **2D panes (CT/CR):** wheel = slice scroll; drag = pan; measurement tools require selecting the tool then clicking points; crosshair drag syncs panes.
- **Cross-sections (pano/implant):** scroll steps perpendicular positions.
- **FDI tooth wheel (MPR):** click a tooth to recenter/isolate; red = has AI finding.
- **No keyboard shortcuts were surfaced** in tooltips/menus during the walkthrough (tooltips name tools, not keys). Tool names come from hover tooltips (e.g. "Measurement", "Occlusal Contact", "Undercut Detection", "Color Switch", "Details", "Download").
- **Other setting:** "Default location after login" = Homepage.

---

## 11. Architecture hints (observed; no payloads captured)

- **Main SPA:** `ai.dentalx.com/eur/`, hash-routed (`#/home`, `#/patientManage`, `#/implantPlan/orderList`, `#/clinicSend/orderList`, `#/groupDetail`, `#/dataCloud`, `#/accountDetail`, `#/link?id=…`). The `eur` path segment ⇒ **multi-region deployment**. Chinese ICP filing (`蜀ICP备2025134658号-2`) ⇒ Sichuan-based vendor.
- **Viewers = separate apps** on `eurs.dentalx.com` with a **numeric instance prefix** (`/1/…`, `/2/…`) that changes between reloads ⇒ **load-balanced GPU instances**. `earth` = CBCT viewer, `saturn` = 2D/CR viewer. The IOS `queenbee` viewer is served from the **CDN host** `eurc.dentalx.com/bird/queenbee/`.
- **Storage:** `ossType=OSS` ⇒ Alibaba OSS object storage; `cdnurl=eurc.dentalx.com` passes the CDN base into viewers.
- **Auth:** short-lived viewer token (`p1296…`) **+ `dx2token` JWT** (HS256, `iss:"dx2"`, ~10 h expiry, carries `gid`=team id and `userid`), passed as **URL query params**. Case = `caseguid`, patient = `patientguid`; 2D viewer additionally gets DICOM `studyuid/seriesuid/sopuid`.
- **Volume delivery:** loads with a single `%` progress ring — looks like a **single-volume download** (≈127 MB case loads in seconds), **not** incremental JPEG-tile slice streaming. WebGL is heavy: switching workspace tabs froze the renderer for **10–30 s** (repeated screenshot/CDP timeouts). An **idle "sleep mode"** suspends the GPU session; resuming does a full reload.
- **Live share:** room-id in `#/link?id=`, operator/participant roles ⇒ **websocket state sync** for co-viewing (not packet-inspected).
- **Scanner clouds:** SHINING 3D / MEDIT bound via **Data Cloud Platform** (`#/dataCloud` → Add Association); once bound, IOS pulls directly from the vendor cloud in upload/order flows.

---

## 12. Not present / gated / not found

- **No case-level chat threads, @mentions, or comment feed** — collaboration is live rooms + email notifications.
- **No patient-facing portal / "send to patient" / patient PDF delivery** (report is Print-only).
- **No folders / tags / archive**; flat per-patient Data & Order lists; no visit/timeline grouping.
- **No "case" or "study" object layer** — data items attach directly to patient.
- **Credit/entitlement gating:** AI orders consume Credits; surgical-guide design and DICOM upload require **downloading a desktop app** ("Install Dental X Guide", "Upload Tool"); storage **"View Benefits"** upsell; some AI object/denture icons greyed.
- **Ceph AI auto-tracing** and **IOS AI segmentation** buttons produced **no visible output** this session (likely async job or entitlement).
- **No DICOM / STL export** surfaced from within the viewers (downloads exist: per-data-card Download in Patient Management, per-pane download on pano/ceph, and order deliverables from Order List).
- **Compare CBCT↔CBCT** needs ≥2 CTs (single-CT patient → "No data"); **CT↔IOS registration** is in Multi-Data Fusion, not the viewer.
- **Screenshots not persisted** by the capture path used this session (see header note).

---

## Appendix — session hygiene / cleanup

Created during the walkthrough (owner may remove):
- **Test patient** "Test Cowork Demo" (`DX20260712MIVQ`).
- **Share room** `192463` (6 h validity, anonymized) — expires automatically.
- No orders were submitted; no existing data was modified or deleted.

## Appendix — mapping to our stack (the delta worth copying)
- **2D CR AI diagnosis** (ranked findings + confidence + boxes) — biggest gap vs our zoom/pan/W-L-only 2D viewer.
- **Per-tooth pathology surfaced on an FDI wheel** + **root-canal measurement** — beyond our current CBCT AI stubs.
- **Live co-viewing rooms with operator/participant roles, expiry, and anonymize toggle** — richer than our tokenized read-only `imaging_share_invites`; consider room-id + role model.
- **Structured lab-order forms** (restoration types, VITA shades, materials, appliances) routing to a **Partners** network with per-order lab email + shipping/urgent — a ready-made schema for our "lab orders and many things" ambition.
- **Credit-metered AI orders** + **online-auto vs desktop-manual** design fork — a monetization/effort-routing pattern.
- **Scanner-cloud binding** (SHINING 3D / MEDIT) as a first-class data source alongside manual/device.
