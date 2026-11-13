/*
 * cephAnalysis — pure cephalometric geometry over manually placed landmarks.
 *
 * NO AI: every value here is plain 2-D geometry computed from the landmark
 * pixel coordinates on the synthetic lateral ceph. The viewer carries an
 * assistive disclaimer ("Tracing aid — verify clinically"); these numbers are
 * a tracing aid, not a diagnosis.
 *
 * Landmarks are stored as { col, row } pixel coordinates on the ceph image
 * (row increases DOWNWARD, i.e. toward inferior — the image is presented with
 * superior at the top). Angles are computed in the image plane; because the
 * ceph is a true-aspect-ratio projection (square pixels in mm), pixel angles
 * equal anatomical angles in the sagittal plane.
 *
 * The classic norms cited in NORMS are the textbook Steiner / Tweed values
 * (Caucasian adult means) and are surfaced as tooltips in the UI.
 */

// The full landmark set, in guided placement order. `key` is the storage key,
// `optional` everything — analysis runs on whatever subset exists.
export const LANDMARKS = [
  { key: 'S', label: 'Sella', hint: 'Centre of sella turcica' },
  { key: 'N', label: 'Nasion', hint: 'Frontonasal suture, most anterior point' },
  { key: 'Po', label: 'Porion', hint: 'Most superior point of external auditory meatus' },
  { key: 'Or', label: 'Orbitale', hint: 'Lowest point of the orbital rim' },
  { key: 'ANS', label: 'ANS', hint: 'Anterior nasal spine' },
  { key: 'PNS', label: 'PNS', hint: 'Posterior nasal spine' },
  { key: 'A', label: 'A-point', hint: 'Deepest point on maxillary alveolar concavity' },
  { key: 'B', label: 'B-point', hint: 'Deepest point on mandibular alveolar concavity' },
  { key: 'Pog', label: 'Pogonion', hint: 'Most anterior point of the bony chin' },
  { key: 'Gn', label: 'Gnathion', hint: 'Most antero-inferior point of the chin' },
  { key: 'Me', label: 'Menton', hint: 'Most inferior point of the symphysis' },
  { key: 'Go', label: 'Gonion', hint: 'Most postero-inferior point of the mandibular angle' },
  { key: 'U1T', label: 'Upper incisor tip', hint: 'Incisal edge of the upper central incisor' },
  { key: 'U1A', label: 'Upper incisor apex', hint: 'Root apex of the upper central incisor' },
  { key: 'L1T', label: 'Lower incisor tip', hint: 'Incisal edge of the lower central incisor' },
  { key: 'L1A', label: 'Lower incisor apex', hint: 'Root apex of the lower central incisor' },
];

export const LANDMARK_KEYS = LANDMARKS.map((l) => l.key);

// Classic norms (adult). range = [low, high] for the amber/red badges.
export const NORMS = {
  SNA:   { mean: 82, sd: 2, range: [80, 84], unit: '°', cite: 'Steiner: SNA 82° ± 2° — maxilla A-P position vs cranial base.' },
  SNB:   { mean: 80, sd: 2, range: [78, 82], unit: '°', cite: 'Steiner: SNB 80° ± 2° — mandible A-P position vs cranial base.' },
  ANB:   { mean: 2, sd: 2, range: [0, 4], unit: '°', cite: 'Steiner: ANB 2° ± 2° — skeletal sagittal jaw relationship (Class I).' },
  FMA:   { mean: 25, sd: 4, range: [21, 29], unit: '°', cite: 'Tweed: FMA (Frankfort–mandibular plane) 25° ± 4°.' },
  SN_MP: { mean: 32, sd: 5, range: [27, 37], unit: '°', cite: 'SN to mandibular plane 32° ± 5° — vertical growth pattern.' },
  U1_SN: { mean: 102, sd: 5, range: [97, 107], unit: '°', cite: 'Upper incisor to SN 102° ± 5° — maxillary incisor inclination.' },
  L1_MP: { mean: 90, sd: 5, range: [85, 95], unit: '°', cite: 'Lower incisor to mandibular plane (IMPA) 90° ± 5°.' },
  Wits:  { mean: 0, sd: 2, range: [-2, 2], unit: ' mm', cite: 'Wits appraisal ≈ 0 mm (♂ +1, ♀ −1) — jaw relation independent of cranial base. APPROXIMATE here (occlusal plane from incisor tips).' },
};

// ── 2-D vector helpers in image space (col=x, row=y, y points DOWN) ──────────
const vsub = (a, b) => ({ x: a.col - b.col, y: a.row - b.row });
const vlen = (v) => Math.hypot(v.x, v.y);

/** Signed angle (deg) from vector u to vector v, in [-180,180]. */
function angleBetweenDeg(u, v) {
  const a = Math.atan2(u.y, u.x);
  const b = Math.atan2(v.y, v.x);
  let d = (b - a) * 180 / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** Unsigned angle at vertex p formed by rays p→a and p→b, in [0,180]. */
export function angleAtVertex(p, a, b) {
  const u = vsub(a, p);
  const v = vsub(b, p);
  const lu = vlen(u);
  const lv = vlen(v);
  if (lu === 0 || lv === 0) return null;
  let cos = (u.x * v.x + u.y * v.y) / (lu * lv);
  cos = Math.max(-1, Math.min(1, cos));
  return Math.acos(cos) * 180 / Math.PI;
}

/** Acute angle (0-90) between two undirected lines a-b and c-d. */
export function lineAngleDeg(a, b, c, d) {
  const u = vsub(b, a);
  const v = vsub(d, c);
  if (vlen(u) === 0 || vlen(v) === 0) return null;
  let ang = Math.abs(angleBetweenDeg(u, v));
  if (ang > 90) ang = 180 - ang;
  return ang;
}

/**
 * Signed perpendicular distance (in pixels) from point p to the line through
 * a→b. Positive on the side toward which the line's left-normal points.
 */
function signedDistToLine(p, a, b) {
  const dx = b.col - a.col;
  const dy = b.row - a.row;
  const L = Math.hypot(dx, dy);
  if (L === 0) return null;
  // Cross product (a→b) x (a→p) / |a→b|.
  return ((dx * (p.row - a.row) - dy * (p.col - a.col)) / L);
}

const has = (lm, ...keys) => keys.every((k) => lm[k] && Number.isFinite(lm[k].col) && Number.isFinite(lm[k].row));

/**
 * Compute every analysis value supported by the present landmark subset.
 *
 * @param {Object} landmarks  { S:{col,row}, N:{...}, ... } (any subset)
 * @param {Object} [options]
 *   mmPerPixel : for Wits (mm). Defaults to 1 (values then reported in px).
 * @returns {Array<{ key, label, value, unit, status, norm, approximate, note }>}
 *   status ∈ 'green'|'amber'|'red'|'na'.
 */
export function computeCephAnalysis(landmarks = {}, options = {}) {
  const lm = landmarks || {};
  const mmPerPixel = options.mmPerPixel || 1;
  const results = [];

  const push = (key, label, value, { approximate = false, note = null } = {}) => {
    const norm = NORMS[key];
    let status = 'na';
    if (value != null && norm) {
      const [lo, hi] = norm.range;
      if (value >= lo && value <= hi) status = 'green';
      else {
        // amber within 1 extra SD of the range edge, red beyond.
        const edge = value < lo ? lo - value : value - hi;
        status = edge <= (norm.sd || 2) ? 'amber' : 'red';
      }
    }
    results.push({
      key, label,
      value: value == null ? null : Math.round(value * 10) / 10,
      unit: norm?.unit || '°',
      status, norm: norm || null, approximate, note,
    });
  };

  // SNA / SNB / ANB — need S, N and A and/or B.
  if (has(lm, 'S', 'N', 'A')) push('SNA', 'SNA', angleAtVertex(lm.N, lm.S, lm.A));
  else push('SNA', 'SNA', null);
  if (has(lm, 'S', 'N', 'B')) push('SNB', 'SNB', angleAtVertex(lm.N, lm.S, lm.B));
  else push('SNB', 'SNB', null);
  if (has(lm, 'S', 'N', 'A', 'B')) {
    // ANB = SNA − SNB, SIGNED: negative when B-point is anterior of A-point
    // (skeletal Class III), positive when A leads B (Class II when large).
    // Unsigned vertex angles lose that sign, and the previous
    // |distance-to-SN-line| heuristic derived it from whichever of A/B lies
    // FARTHER from the S-N line — but that perpendicular distance grows with
    // |N→landmark| too (B on the mandible is normally much farther from N
    // than A), so normal anatomy flipped the sign either way. Instead take
    // the SIGNED rotation of N→A and N→B away from the N→S ray; A and B sit
    // on the anterior side of the S-N line, so the rotation direction they
    // share is the anterior (positive) sense regardless of which way the
    // patient faces in the image.
    let anb = null;
    const u = vsub(lm.S, lm.N);
    const va = vsub(lm.A, lm.N);
    const vb = vsub(lm.B, lm.N);
    if (vlen(u) > 0 && vlen(va) > 0 && vlen(vb) > 0) {
      const sA = angleBetweenDeg(u, va); // signed SNA (sign = side of the S-N line)
      const sB = angleBetweenDeg(u, vb); // signed SNB
      const anteriorSign = Math.sign(sA) || Math.sign(sB) || 1;
      anb = (sA - sB) * anteriorSign;
    }
    push('ANB', 'ANB', anb);
  } else push('ANB', 'ANB', null);

  // FMA — Frankfort (Po-Or) to mandibular plane (Go-Me).
  if (has(lm, 'Po', 'Or', 'Go', 'Me')) push('FMA', 'FMA', lineAngleDeg(lm.Po, lm.Or, lm.Go, lm.Me));
  else push('FMA', 'FMA', null);

  // SN-MP — SN line (S-N) to mandibular plane (Go-Me).
  if (has(lm, 'S', 'N', 'Go', 'Me')) push('SN_MP', 'SN-MP', lineAngleDeg(lm.S, lm.N, lm.Go, lm.Me));
  else push('SN_MP', 'SN-MP', null);

  // U1-SN — upper incisor long axis (U1A-U1T) to SN line.
  if (has(lm, 'S', 'N', 'U1T', 'U1A')) push('U1_SN', 'U1-SN', lineAngleDeg(lm.U1A, lm.U1T, lm.S, lm.N));
  else push('U1_SN', 'U1-SN', null);

  // L1-MP (IMPA) — lower incisor long axis to mandibular plane.
  if (has(lm, 'L1T', 'L1A', 'Go', 'Me')) push('L1_MP', 'L1-MP', lineAngleDeg(lm.L1A, lm.L1T, lm.Go, lm.Me));
  else push('L1_MP', 'L1-MP', null);

  // Wits — A and B projected onto the occlusal plane. We APPROXIMATE the
  // occlusal plane from the incisor tips (true Wits uses the functional
  // occlusal plane through the molar/premolar cusps). Labelled approximate.
  if (has(lm, 'A', 'B', 'U1T', 'L1T')) {
    // Occlusal plane: line through the two incisor tips (a coarse proxy).
    const op0 = lm.U1T;
    const op1 = lm.L1T;
    const dA = signedDistToLine(lm.A, op0, op1);
    const dB = signedDistToLine(lm.B, op0, op1);
    let wits = null;
    if (dA != null && dB != null) {
      // Wits = AO − BO along the occlusal plane (signed A-P separation). We use
      // the projection difference scaled to mm.
      // Project A and B onto the occlusal plane direction.
      const dir = { x: op1.col - op0.col, y: op1.row - op0.row };
      const dl = Math.hypot(dir.x, dir.y) || 1;
      const ux = dir.x / dl;
      const uy = dir.y / dl;
      const projA = (lm.A.col - op0.col) * ux + (lm.A.row - op0.row) * uy;
      const projB = (lm.B.col - op0.col) * ux + (lm.B.row - op0.row) * uy;
      wits = (projA - projB) * mmPerPixel;
    }
    push('Wits', 'Wits (approx)', wits, {
      approximate: true,
      note: 'Occlusal plane approximated from incisor tips — verify against molar occlusion.',
    });
  } else push('Wits', 'Wits (approx)', null, { approximate: true });

  return results;
}
