/*
 * dicomStack — turn a raw pile of DICOM imageIds into one clean, ordered CBCT series
 * before cornerstone builds a volume from it.
 *
 * The streaming volume loader needs every slice's geometry up front, but wadouri /
 * dicomfile metadata only exists once each dataset has been parsed. Dental CBCT
 * exports also mix the main axial reconstruction with scouts and secondary series,
 * and some scanners stamp slices in arbitrary file order. So we:
 *   1. parse every dataset (metadata only — no pixel decode),
 *   2. expand multi-frame files into one imageId per frame,
 *   3. group by SeriesInstanceUID + orientation and keep the largest coherent group,
 *   4. sort by ImagePositionPatient projected onto the slice normal.
 * Steps 3–4 are the fixes aihealth-imaging's first CBCT viewer landed (May 2026).
 */
import { ensureCornerstone } from '@/lib/cornerstoneInit';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const orientKey = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v).map((x) => Number(x).toFixed(3)).join(',') : 'na');

// Parse datasets a few at a time so a 600-slice export doesn't open 600 readers at once.
async function parseAll(ids, wadouri, onProgress) {
  const out = new Array(ids.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      const parsed = wadouri.parseImageId(ids[i]);
      try {
        out[i] = await wadouri.dataSetCacheManager.load(parsed.url, wadouri.getLoaderForScheme(parsed.scheme), ids[i]);
      } catch {
        out[i] = null; // not DICOM (DICOMDIR, readme, thumbnails…)
      }
      done += 1;
      if (onProgress && (done % 8 === 0 || done === ids.length)) onProgress(done / ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
  return out;
}

/**
 * @param {string[]} imageIds  wadouri:<url> or dicomfile:<n> ids, any order, any mix of series
 * @param {{ onProgress?: (fraction:number) => void }} [opts]
 * @returns {Promise<{ imageIds: string[], info: object }>}
 */
export async function prepareDicomStack(imageIds, { onProgress } = {}) {
  const cs = await ensureCornerstone();
  const { wadouri } = cs.dicomImageLoader;
  const { metaData } = cs.core;

  const dataSets = await parseAll(imageIds, wadouri, onProgress);

  // One id per frame; drop files with no pixel data.
  const frameIds = [];
  dataSets.forEach((ds, i) => {
    if (!ds || !ds.elements?.x7fe00010) return;
    const frames = Number.parseInt(ds.string('x00280008') || '1', 10) || 1;
    if (frames > 1) for (let f = 1; f <= frames; f++) frameIds.push(`${imageIds[i]}?frame=${f}`);
    else frameIds.push(imageIds[i]);
  });
  if (!frameIds.length) throw new Error('None of these files contain DICOM images.');

  // Group by series + orientation; scouts and secondary recons land in their own groups.
  const groups = new Map();
  for (const id of frameIds) {
    const series = metaData.get('generalSeriesModule', id);
    const plane = metaData.get('imagePlaneModule', id);
    const key = `${series?.seriesInstanceUID || 'unknown'}::${orientKey(plane?.rowCosines)}|${orientKey(plane?.columnCosines)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  const ranked = [...groups.entries()]
    .map(([key, ids]) => ({ key, ids, hasOrient: !key.endsWith('::na|na') }))
    .sort((a, b) => b.ids.length - a.ids.length || Number(b.hasOrient) - Number(a.hasOrient));
  let picked = ranked[0].ids;
  if (picked.length < 3) picked = frameIds; // tiny best group: show everything rather than nothing

  // Sort by position along the slice normal (row × column cosines).
  const ref = metaData.get('imagePlaneModule', picked[0]);
  const normal = cross(ref?.rowCosines ? Array.from(ref.rowCosines) : [1, 0, 0], ref?.columnCosines ? Array.from(ref.columnCosines) : [0, 1, 0]);
  const withPos = picked.map((id, order) => {
    const ipp = metaData.get('imagePlaneModule', id)?.imagePositionPatient;
    const inst = metaData.get('generalImageModule', id)?.instanceNumber;
    return { id, z: ipp && ipp.length === 3 ? dot(Array.from(ipp), normal) : null, inst: Number(inst) || order };
  });
  const positioned = withPos.every((s) => s.z !== null);
  withPos.sort((a, b) => (positioned ? a.z - b.z : a.inst - b.inst));

  // Same-position duplicates (some exports write a slice twice) would collapse the volume's Z spacing.
  const sorted = positioned ? withPos.filter((s, i) => i === 0 || Math.abs(s.z - withPos[i - 1].z) > 1e-3) : withPos;

  const deltas = [];
  for (let i = 1; i < sorted.length; i++) if (positioned) deltas.push(sorted[i].z - sorted[i - 1].z);
  deltas.sort((a, b) => a - b);
  const spacing = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null;

  return {
    imageIds: sorted.map((s) => s.id),
    info: {
      files: imageIds.length,
      frames: frameIds.length,
      series: groups.size,
      slices: sorted.length,
      sliceSpacing: spacing,
      irregular: !!(spacing && deltas.length && deltas[deltas.length - 1] > spacing * 1.5),
      sortedBy: positioned ? 'position' : 'instance number',
    },
  };
}
