/*
 * make-sample-cbct — writes public/samples/demo-cbct-dicom.zip, a synthetic dental
 * CBCT exported the way scanners do it, for demos and for testing the viewer.
 *
 * Anatomy (HU): U-shaped mandible and maxilla with cortical shell and trabecular
 * bone, 13 lower and 14 upper teeth (enamel, dentin, pulp, PDL), the inferior
 * alveolar canals, an implant with crown at 36 and a healed, missing 46 site
 * (the implant-guide case), soft tissue envelope and airway.
 *
 * Export quirks on purpose: raw 12-bit unsigned pixels with RescaleIntercept -1000,
 * slices numbered top-down (ImagePositionPatient z decreasing), shuffled file names,
 * and a two-image scout in a separate series — the viewer must pick and sort the
 * real series itself.
 *
 *   node scripts/make-sample-cbct.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, zipSync } from 'fflate';

const NX = 200, NY = 180, NZ = 140, SP = 0.4;            // 80 × 72 × 56 mm at 0.4 mm
const CX = (NX * SP) / 2;

// ── Arch geometry (axial plane, mm; y grows posterior) ──────────────────────────
const arch = (y0, k) => {
  const pts = [];
  for (let x = CX - 31; x <= CX + 31; x += 0.25) pts.push([x, y0 + k * (x - CX) ** 2]);
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const mid = s[Math.floor(pts.length / 2)];
  return { pts, s: s.map((v) => v - mid) };          // s: signed arc length from the midline (− = patient right)
};
const LOWER = arch(15, 0.05), UPPER = arch(13.2, 0.046);

// Nearest arch sample for every axial column: signed arc position and buccal distance.
function columnMap(a) {
  const m = new Float32Array(NX * NY * 2);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const x = i * SP, y = j * SP;
    let best = 1e9, bi = 0;
    for (let p = 0; p < a.pts.length; p += 2) { const d = (a.pts[p][0] - x) ** 2 + (a.pts[p][1] - y) ** 2; if (d < best) { best = d; bi = p; } }
    const [px, py] = a.pts[bi];
    const q = a.pts[Math.min(a.pts.length - 1, bi + 2)], r = a.pts[Math.max(0, bi - 2)];
    const tx = q[0] - r[0], ty = q[1] - r[1], tl = Math.hypot(tx, ty) || 1;
    // Outward (buccal) normal points away from the arch's concave side (+y is inside the U).
    let nx = -ty / tl, ny = tx / tl;
    if (ny > 0) { nx = -nx; ny = -ny; }
    m[(j * NX + i) * 2] = a.s[bi];
    m[(j * NX + i) * 2 + 1] = (x - px) * nx + (y - py) * ny;
  }
  return m;
}
const LM = columnMap(LOWER), UM = columnMap(UPPER);

// Teeth along the arch: [FDI right, FDI left, mesiodistal width, buccolingual half-width]
const LOWER_TEETH = [[41, 31, 5.3, 2.9], [42, 32, 5.9, 3.0], [43, 33, 7, 3.7], [44, 34, 7, 3.8], [45, 35, 7.2, 4.0], [46, 36, 11, 5.0], [47, 37, 10.5, 4.8]];
const UPPER_TEETH = [[11, 21, 8.5, 3.3], [12, 22, 6.6, 3.0], [13, 23, 7.6, 3.9], [14, 24, 7, 4.3], [15, 25, 6.8, 4.3], [16, 26, 10.2, 5.4], [17, 27, 9.2, 5.2]];
const place = (list) => {
  const out = [];
  let s = 0;
  for (const [r, l, w, b] of list) { out.push({ fdi: r, s: -(s + w / 2), w, b }, { fdi: l, s: s + w / 2, w, b }); s += w; }
  return out;
};
const LT = place(LOWER_TEETH), UT = place(UPPER_TEETH);
const MISSING = new Set([46]);
const IMPLANT = 36;

// Smooth pseudo-random texture so bone isn't flat (deterministic, compresses well).
const tex = (x, y, z) => Math.sin(x * 2.1 + Math.sin(y * 1.3)) * Math.sin(y * 1.7 + z * 0.9) * Math.sin(z * 2.3 + x * 0.7);

function tooth(t, ds, db, z, jaw) {
  // jaw: 'lower' (crown up) or 'upper' (crown down). Returns HU or null.
  const cej = jaw === 'lower' ? 23 : 39, tip = jaw === 'lower' ? 30.4 : 31.4, apex = jaw === 'lower' ? 8 + (t.w > 9 ? 1 : 0) : 53;
  const up = jaw === 'lower' ? 1 : -1;
  const h = (z - cej) * up;                       // + into the crown, − into the root
  const crownH = (tip - cej) * up, rootH = (cej - apex) * up;
  let scale;
  if (h >= 0) { if (h > crownH) return null; const f = h / crownH; scale = f < 0.55 ? 1 : Math.sqrt(Math.max(0, 1 - ((f - 0.55) / 0.45) ** 2)); }
  else { const f = -h / rootH; if (f > 1) return null; scale = 0.82 * (1 - f) + 0.32 * f; }
  const rm = (t.w / 2) * 0.92 * scale, rb = t.b * scale;
  if (rm <= 0 || rb <= 0) return null;
  const rr = Math.sqrt((ds / rm) ** 2 + (db / rb) ** 2);
  if (rr > 1.08 && h < 0) return rr < 1.2 ? 'pdl' : null;   // periodontal ligament around roots
  if (rr > 1) return null;
  if (rr < 0.28 && h < crownH * 0.75 && -h < rootH * 0.92) return 40;            // pulp / canal
  if (h >= 0 && rr > 1 - 1.1 / Math.max(rm, rb)) return 2700;                    // enamel shell
  return 1650;                                                                   // dentin
}

function implant(ds, db, z) {
  const r = Math.hypot(ds, db);
  if (z >= 11 && z <= 22) { const thread = 0.18 * Math.sin((z * 2 * Math.PI) / 0.8); return r <= 1.95 + thread ? 3071 : null; }
  if (z > 22 && z <= 24.5) return r <= 1.6 ? 3071 : null;                         // abutment
  if (z > 24.5 && z <= 30.4) { const f = (z - 24.5) / 5.9; return Math.sqrt((ds / 5.2) ** 2 + (db / 4.8) ** 2) <= (f < 0.6 ? 1 : Math.sqrt(1 - ((f - 0.6) / 0.4) ** 2)) ? 2400 : null; } // zirconia crown
  return null;
}

function voxel(i, j, k) {
  const x = i * SP, y = j * SP, z = k * SP;
  // Soft tissue envelope and airway
  const inFace = ((x - CX) / 39) ** 2 + ((y - 40) / 36) ** 2 <= 1 && y > 4;
  if (!inFace) return -1000;
  if (Math.hypot(x - CX, y - 64) < 6.5) return -1000;
  let v = 40 + 15 * tex(x, y, z);

  // ── Mandible ──
  const ls = LM[(j * NX + i) * 2], ld = LM[(j * NX + i) * 2 + 1];
  if (Math.abs(ls) < 58) {
    const site46 = Math.abs(ls - LT.find((t) => t.fdi === 46).s) < 6;
    const crest = site46 ? 19.5 - 1.2 * Math.cos(((ls - LT.find((t) => t.fdi === 46).s) / 6) * Math.PI / 2) : 22;
    if (z >= 2 && z <= crest) {
      const half = (site46 ? 3.2 : 3.6) + ((crest - z) / 20) * 2.6;
      const bottom = z < 5 ? Math.sqrt(Math.max(0, 1 - ((5 - z) / 3) ** 2)) : 1;
      const edge = half * bottom - Math.abs(ld + 0.4);
      if (edge >= 0) {
        v = edge < 1.5 || z < 3.4 ? 1350 + 80 * tex(x * 3, y * 3, z) : 380 + 140 * tex(x * 2, y * 2, z * 2);
        // Inferior alveolar canal: posterior to the mental foramen (|s| > 22), slightly lingual.
        const as = Math.abs(ls);
        if (as > 21) {
          const cz = 8.6 + (as < 30 ? (30 - as) * 0.12 : 0);
          const dc = Math.hypot(ld + 0.9, z - cz);
          if (dc < 1.25) v = 30; else if (dc < 1.75) v = 950;
        }
      }
    }
    // Lower teeth / implant / gap
    for (const t of LT) {
      const ds = ls - t.s;
      if (Math.abs(ds) > t.w) continue;
      if (MISSING.has(t.fdi)) continue;
      if (t.fdi === IMPLANT) { const iv = implant(ds, ld, z); if (iv !== null) v = iv; continue; }
      const tv = tooth(t, ds, ld, z, 'lower');
      if (tv === 'pdl') { if (v > 300) v = 120; } else if (tv !== null) v = tv;
    }
  }

  // ── Maxilla ──
  const us = UM[(j * NX + i) * 2], ud = UM[(j * NX + i) * 2 + 1];
  if (Math.abs(us) < 56 && z >= 38) {
    const half = 3.8 + ((z - 38) / 18) * 3.2;
    if (z >= 40.5 && half - Math.abs(ud + 0.6) >= 0) v = half - Math.abs(ud + 0.6) < 1.3 ? 1250 + 80 * tex(x * 3, y * 3, z) : 360 + 140 * tex(x * 2, y * 2, z * 2);
    for (const t of UT) {
      const ds = us - t.s;
      if (Math.abs(ds) > t.w) continue;
      const tv = tooth(t, ds, ud, z, 'upper');
      if (tv === 'pdl') { if (v > 300) v = 120; } else if (tv !== null) v = tv;
    }
  }
  // Hard palate inside the upper arch
  if (z > 49 && z < 52.5 && ud < -4.5 && Math.abs(us) < 40 && y < 52) v = Math.max(v, 1100 + 80 * tex(x, y, z));
  return v;
}

// ── DICOM writer (Explicit VR Little Endian) ────────────────────────────────────
const enc = new TextEncoder();
function el(group, element, vr, value) {
  let body;
  if (value instanceof Uint8Array) body = value;
  else if (vr === 'US') { body = new Uint8Array(2); new DataView(body.buffer).setUint16(0, value, true); }
  else if (vr === 'UL') { body = new Uint8Array(4); new DataView(body.buffer).setUint32(0, value, true); }
  else { body = enc.encode(String(value)); }
  if (body.length % 2) { const p = new Uint8Array(body.length + 1); p.set(body); p[body.length] = vr === 'UI' || vr === 'OB' ? 0 : 0x20; body = p; }
  const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const head = new Uint8Array(long ? 12 : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, group, true); dv.setUint16(2, element, true);
  head[4] = vr.charCodeAt(0); head[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, body.length, true); else dv.setUint16(6, body.length, true);
  const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length);
  return out;
}
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let off = 0; for (const p of parts) { o.set(p, off); off += p.length; } return o; };

const ROOT = '1.2.826.0.1.3680043.10.1499';
const STUDY = `${ROOT}.1.20261025`;
const SERIES = `${ROOT}.2.20261025.1`, SCOUT = `${ROOT}.2.20261025.9`;
const CT = '1.2.840.10008.5.1.4.1.1.2';

function dicom({ sop, series, seriesNo, instance, ipp, iop, rows, cols, pixels, desc, imageType }) {
  const meta = cat([
    el(0x0002, 0x0001, 'OB', new Uint8Array([0, 1])),
    el(0x0002, 0x0002, 'UI', CT),
    el(0x0002, 0x0003, 'UI', sop),
    el(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
    el(0x0002, 0x0012, 'UI', `${ROOT}.9`),
  ]);
  const ds = cat([
    el(0x0008, 0x0008, 'CS', imageType),
    el(0x0008, 0x0016, 'UI', CT),
    el(0x0008, 0x0018, 'UI', sop),
    el(0x0008, 0x0020, 'DA', '20261025'),
    el(0x0008, 0x0060, 'CS', 'CT'),
    el(0x0008, 0x0070, 'LO', 'aiHealth Imaging'),
    el(0x0008, 0x103e, 'LO', desc),
    el(0x0008, 0x1090, 'LO', 'Synthetic dental phantom'),
    el(0x0010, 0x0010, 'PN', 'DEMO^PHANTOM'),
    el(0x0010, 0x0020, 'LO', 'DEMO-0001'),
    el(0x0018, 0x0050, 'DS', SP.toFixed(2)),
    el(0x0020, 0x000d, 'UI', STUDY),
    el(0x0020, 0x000e, 'UI', series),
    el(0x0020, 0x0011, 'IS', String(seriesNo)),
    el(0x0020, 0x0013, 'IS', String(instance)),
    el(0x0020, 0x0032, 'DS', ipp.map((v) => v.toFixed(3)).join('\\')),
    el(0x0020, 0x0037, 'DS', iop.join('\\')),
    el(0x0028, 0x0002, 'US', 1),
    el(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    el(0x0028, 0x0010, 'US', rows),
    el(0x0028, 0x0011, 'US', cols),
    el(0x0028, 0x0030, 'DS', `${SP.toFixed(2)}\\${SP.toFixed(2)}`),
    el(0x0028, 0x0100, 'US', 16),
    el(0x0028, 0x0101, 'US', 12),
    el(0x0028, 0x0102, 'US', 11),
    el(0x0028, 0x0103, 'US', 0),
    el(0x0028, 0x1050, 'DS', '1400'),
    el(0x0028, 0x1051, 'DS', '3000'),
    el(0x0028, 0x1052, 'DS', '-1000'),
    el(0x0028, 0x1053, 'DS', '1'),
    el(0x7fe0, 0x0010, 'OW', new Uint8Array(pixels.buffer)),
  ]);
  const preamble = new Uint8Array(132); preamble.set(enc.encode('DICM'), 128);
  return cat([preamble, el(0x0002, 0x0000, 'UL', meta.length), meta, ds]);
}

// ── Build the series ────────────────────────────────────────────────────────────
const files = {};
const order = [...Array(NZ).keys()].sort((a, b) => ((a * 7919) % NZ) - ((b * 7919) % NZ)); // deterministic shuffle
const raw = (hu) => Math.max(0, Math.min(4095, Math.round(hu + 1000)));
const hu = new Int16Array(NX * NY * NZ); // same volume as NIfTI (what the Cloud Run converter would produce)
for (let k = 0; k < NZ; k++) {
  const px = new Uint16Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const r = raw(voxel(i, j, k));
    px[j * NX + i] = r;
    hu[k * NX * NY + j * NX + i] = r - 1000;
  }
  // Top-down numbering: instance 1 is the most superior slice. LPS: x → patient left, y → posterior, z → superior.
  const instance = NZ - k;
  const name = `IMG${String(order.indexOf(k) + 1).padStart(4, '0')}.dcm`;
  files[`DEMO_CBCT/${name}`] = dicom({
    sop: `${ROOT}.3.${instance}`, series: SERIES, seriesNo: 2, instance,
    ipp: [-CX, -36, -28 + k * SP], iop: [1, 0, 0, 0, 1, 0], rows: NY, cols: NX, pixels: px,
    desc: 'CBCT 8x7 0.4mm', imageType: 'ORIGINAL\\PRIMARY\\AXIAL',
  });
  if (k % 20 === 0) process.stdout.write(`slice ${k}/${NZ}\r`);
}
// Scout: two coronal localizers in their own series.
for (let s = 0; s < 2; s++) {
  const px = new Uint16Array(NX * NZ);
  const j = 60 + s * 30;
  for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) px[(NZ - 1 - k) * NX + i] = raw(voxel(i, j, k));
  files[`DEMO_CBCT/SCOUT${s + 1}.dcm`] = dicom({
    sop: `${ROOT}.4.${s + 1}`, series: SCOUT, seriesNo: 1, instance: s + 1,
    ipp: [-CX, -36 + j * SP, 28], iop: [1, 0, 0, 0, 0, -1], rows: NZ, cols: NX, pixels: px,
    desc: 'Scout', imageType: 'ORIGINAL\\PRIMARY\\LOCALIZER',
  });
}
files['DEMO_CBCT/README.txt'] = enc.encode('Synthetic dental CBCT phantom generated by aiHealth Imaging. Not a real patient.\n');

mkdirSync('public/samples', { recursive: true });
const zip = zipSync(files, { level: 6 });
writeFileSync('public/samples/demo-cbct-dicom.zip', zip);
console.log(`\nwrote public/samples/demo-cbct-dicom.zip — ${NZ} slices + 2 scouts, ${(zip.length / 1e6).toFixed(1)} MB`);

// ── NIfTI-1 (.nii.gz), RAS sform — voxel i → patient left, j → posterior, k → superior ──
const header = new DataView(new ArrayBuffer(352));
header.setInt32(0, 348, true);
[3, NX, NY, NZ, 1, 1, 1, 1].forEach((v, n) => header.setInt16(40 + n * 2, v, true));
header.setInt16(70, 4, true);   // datatype INT16
header.setInt16(72, 16, true);  // bitpix
[1, SP, SP, SP, 1, 0, 0, 0].forEach((v, n) => header.setFloat32(76 + n * 4, v, true));
header.setFloat32(108, 352, true); // vox_offset
header.setFloat32(112, 1, true);   // scl_slope
header.setUint8(123, 2);           // xyzt_units: mm
enc.encode('aiHealth Imaging synthetic dental CBCT').forEach((b, n) => header.setUint8(148 + n, b));
header.setInt16(254, 1, true);     // sform_code: scanner
// LPS origin of voxel 0 is (-CX, -36, -28); RAS flips x and y.
[[-SP, 0, 0, CX], [0, -SP, 0, 36], [0, 0, SP, -28]].forEach((row, r) => row.forEach((v, c) => header.setFloat32(280 + r * 16 + c * 4, v, true)));
enc.encode('n+1\0').forEach((b, n) => header.setUint8(344 + n, b));
const nii = gzipSync(cat([new Uint8Array(header.buffer), new Uint8Array(hu.buffer)]), { level: 6 });
writeFileSync('public/samples/demo-cbct.nii.gz', nii);
console.log(`wrote public/samples/demo-cbct.nii.gz — ${NX}×${NY}×${NZ} @ ${SP} mm, ${(nii.length / 1e6).toFixed(1)} MB`);
