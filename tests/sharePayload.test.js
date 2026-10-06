import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  readSharePayload,
  shareDicomFiles,
  shareDicomSeries,
  shareMeshFiles,
} from '../src/lib/sharePayload';

// Minimal payload in the shape /api/imaging-share-resolve returns.
const PAYLOAD = {
  signed_urls_expires_at: new Date(Date.now() + 600000).toISOString(),
  study: { id: 'study-1', study_type: 'cbct', study_date: '2026-07-01', patient_name: 'Test P' },
  files: [
    { url: 'https://signed/a.dcm', fileName: 'a.dcm', fileKind: 'dicom', sopInstanceUid: '1.2.3.1' },
    { url: 'https://signed/b.dcm', fileName: 'b.dcm', fileKind: 'dicom', sopInstanceUid: '1.2.3.2' },
    { url: 'https://signed/upper.stl', fileName: 'upper.stl', fileKind: 'stl' },
    { url: 'https://signed/lower.ply', fileName: 'lower.ply', fileKind: 'ply' },
    { url: 'https://signed/photo.jpg', fileName: 'photo.jpg', fileKind: 'jpeg' },
    { url: null, fileName: 'unsigned.dcm', fileKind: 'dicom' }, // signing failed
  ],
  niftiUrl: 'https://signed/volume.nii.gz',
  viewer_annotations: { version: 2, annotations: [] },
  permission: 'view',
};

function stubSessionStorage(entries = {}) {
  const store = new Map(Object.entries(entries));
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  });
}

describe('readSharePayload', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the parsed payload for a valid key', () => {
    stubSessionStorage({ 'share-abc12345': JSON.stringify(PAYLOAD) });
    const p = readSharePayload('share-abc12345');
    expect(p).toBeTruthy();
    expect(p.study.id).toBe('study-1');
    expect(p.files).toHaveLength(6);
  });

  it.each([undefined, 'bad', new Date(0).toISOString()])('rejects expired or undated cached access %s', expiry => {
    stubSessionStorage({ expired: JSON.stringify({ ...PAYLOAD, signed_urls_expires_at: expiry }) });
    expect(readSharePayload('expired')).toBeNull();
  });

  it('returns null for a missing key', () => {
    stubSessionStorage();
    expect(readSharePayload('share-nope')).toBeNull();
  });

  it('returns null for a null/undefined key', () => {
    stubSessionStorage();
    expect(readSharePayload(null)).toBeNull();
    expect(readSharePayload(undefined)).toBeNull();
  });

  it('returns null when window is not defined (SSR safety)', () => {
    // No stub: node test env has no window global.
    expect(readSharePayload('share-abc')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    stubSessionStorage({ 'share-bad': '{not json' });
    expect(readSharePayload('share-bad')).toBeNull();
  });

  it('returns null when the payload has no study (wrong shape)', () => {
    stubSessionStorage({ 'share-shape': JSON.stringify({ files: [] }) });
    expect(readSharePayload('share-shape')).toBeNull();
  });
});

describe('shareDicomFiles', () => {
  it('keeps only signed DICOM instances', () => {
    const dicoms = shareDicomFiles(PAYLOAD);
    expect(dicoms).toHaveLength(2);
    expect(dicoms.every((f) => f.fileKind === 'dicom' && f.url)).toBe(true);
  });

  it('is empty-safe on null payloads', () => {
    expect(shareDicomFiles(null)).toEqual([]);
    expect(shareDicomFiles({})).toEqual([]);
  });
});

describe('shareMeshFiles', () => {
  it('keeps only signed STL/PLY/OBJ meshes', () => {
    const meshes = shareMeshFiles(PAYLOAD);
    expect(meshes.map((f) => f.fileKind).sort()).toEqual(['ply', 'stl']);
  });

  it('is empty-safe on null payloads', () => {
    expect(shareMeshFiles(null)).toEqual([]);
    expect(shareMeshFiles({})).toEqual([]);
  });
});


describe('authorized shared DICOM series adapter', () => {
  const f = (id, series, n, z, frames = 1) => ({ fileId: id, fileKind: 'dicom', fileName: `${id}.dcm`,
    url: `https://signed.invalid/${id}?token=synthetic`, seriesInstanceUid: series, sopInstanceUid: `1.4.${n}`,
    instanceNumber: n, dicomAcquisition: { numberOfFrames: frames, imageOrientationPatient: [1,0,0,0,1,0], imagePositionPatient: [0,0,z] } });
  it('keeps scouts and maps geometrically ordered instances to exact signed URLs plus frames', () => {
    const groups = shareDicomSeries({ files: [f('later', '1.2', 1, 20), f('first', '1.2', 2, 10), f('scout', '1.3', 3, 0, 2)] });
    expect(groups).toHaveLength(2);
    expect(groups[0].files.map(file => file.id)).toEqual(['first', 'later']);
    expect(groups[0].frames[0].imageId).toBe('wadouri:https://signed.invalid/first?token=synthetic');
    expect(groups[1].frames.map(frame => frame.imageId)).toEqual([
      'wadouri:https://signed.invalid/scout?token=synthetic&frame=1',
      'wadouri:https://signed.invalid/scout?token=synthetic&frame=2',
    ]);
  });
  it('rejects missing or duplicated file identities instead of swapping grants', () => {
    expect(() => shareDicomSeries({ files: [f(null, '1.2', 1, 0)] })).toThrow(/identities/);
    expect(() => shareDicomSeries({ files: [f('same', '1.2', 1, 0), f('same', '1.2', 2, 1)] })).toThrow(/identities/);
  });
});
