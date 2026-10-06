const normalizeDicomUid = value => {
  const uid = String(value ?? '').replace(/\0/g, '').trim();
  return uid.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(uid) ? uid : null;
};

const natural = new Intl.Collator(undefined, { numeric: true }).compare;
const metadata = file => file.dicom_acquisition || {};
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

export function orderDicomSeries(files) {
  const orientation = metadata(files[0] || {}).imageOrientationPatient;
  let normal = null;
  if (vector(orientation, 6)) {
    const row = orientation.slice(0, 3), column = orientation.slice(3);
    if (Math.abs(dot(row, row) - 1) < 0.001 && Math.abs(dot(column, column) - 1) < 0.001 && Math.abs(dot(row, column)) < 0.001) {
      normal = [row[1] * column[2] - row[2] * column[1], row[2] * column[0] - row[0] * column[2], row[0] * column[1] - row[1] * column[0]];
    }
  }
  const spatial = normal && files.every(file => {
    const info = metadata(file);
    return (info.numberOfFrames ?? 1) === 1 && vector(info.imagePositionPatient, 3)
      && vector(info.imageOrientationPatient, 6)
      && info.imageOrientationPatient.every((value, index) => Math.abs(value - orientation[index]) < 0.001);
  });
  const ordered = [...files].sort((a, b) => {
    if (spatial) {
      const distance = dot(metadata(a).imagePositionPatient, normal) - dot(metadata(b).imagePositionPatient, normal);
      if (Math.abs(distance) > 0.0001) return distance;
    }
    const instanceA = Number.isFinite(a.instance_number) ? a.instance_number : Number.MAX_SAFE_INTEGER;
    const instanceB = Number.isFinite(b.instance_number) ? b.instance_number : Number.MAX_SAFE_INTEGER;
    return instanceA - instanceB || natural(a.original_filename || a.storage_path, b.original_filename || b.storage_path);
  });
  return { files: ordered, ordering: spatial ? 'Image position' : 'Instance number / filename' };
}

export function dicomStudySeries(files) {
  const groups = new Map(), seen = new Set();
  for (const file of files) {
    const uid = normalizeDicomUid(file.series_instance_uid);
    const sop = normalizeDicomUid(file.sop_instance_uid);
    if (files.length > 1 && (!uid || !sop)) throw new Error('DICOM series and instance identities are required to browse this study.');
    if (sop && seen.has(sop)) throw new Error('Duplicate DICOM instance identities in this study.');
    if (sop) seen.add(sop);
    const key = uid || 'legacy-single-image';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  return [...groups.entries()].sort(([uidA, a], [uidB, b]) => {
    const numberA = Number.isFinite(a[0].series_number) ? a[0].series_number : Number.MAX_SAFE_INTEGER;
    const numberB = Number.isFinite(b[0].series_number) ? b[0].series_number : Number.MAX_SAFE_INTEGER;
    return numberA - numberB || natural(uidA, uidB);
  }).map(([uid, members], index) => ({
    uid, label: `${index + 1}: ${members[0].series_description || 'DICOM series'}${members[0].series_number != null ? ` (series ${members[0].series_number})` : ''}`,
    ...orderDicomSeries(members),
  }));
}

export function dicomFrameIds(files, signed = []) {
  const byPath = new Map((signed || []).map(item => [item.path, item]));
  if (byPath.size !== files.length || signed.length !== files.length) throw new Error('Could not open every DICOM image. Reopen the study to refresh access.');
  const frames = [];
  for (const file of files) {
    const access = byPath.get(file.storage_path);
    if (!access?.signedUrl || access.error) throw new Error('Could not open every DICOM image. Reopen the study to refresh access.');
    const count = metadata(file).numberOfFrames ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > 100000 || frames.length + count > 100000) throw new Error('This series has an invalid or unsupported frame count.');
    for (let frame = 1; frame <= count; frame += 1) {
      // cornerstone 4 wadouri accepts one-based frame= and strips that suffix
      // before fetching; append after the signed URL without changing its token.
      const suffix = count === 1 ? '' : `${access.signedUrl.includes('?') ? '&' : '?'}frame=${frame}`;
      frames.push({ id: count === 1 ? file.id : `${file.id}:${frame}`, sourceId: file.id, frame,
        imageId: `wadouri:${access.signedUrl}${suffix}` });
    }
  }
  return frames;
}
