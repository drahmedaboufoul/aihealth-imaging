import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { shareMeshFiles, isRigidScanMatrix } from '../src/lib/sharePayload';
import { loadOneFile } from '../src/components/ios-viewer/MultiMeshModel';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const file = (name: string, id = name) => ({ fileId: id, fileName: name, fileKind: name.split('.').pop(), url: `https://scan.invalid/${name}` });

describe('captured scan binding', () => {
  it('binds exact Fussen case/segment sidecars, never segment 1 to segment 10', () => {
    const files = [file('TextureMesh2_1.obj'), file('TextureMesh2_10.obj'), file('FussenTexture2_1.jpg'), file('FussenTexture2_10.jpg')];
    const meshes = shareMeshFiles({ files });
    expect(meshes.map((m) => m.textureUrl)).toEqual([files[2].url, files[3].url]);
    expect(shareMeshFiles({ files: [files[0], files[3]] })[0].textureUrl).toBeUndefined();
  });
  it('does not guess an ambiguous texture and selects one surface per component', () => {
    const files = [file('upper.stl'), file('upper.obj'), file('upper.jpg'), file('upper.png')];
    const result = shareMeshFiles({ files });
    expect(result).toHaveLength(1);
    expect(result[0].textureUrl).toBeUndefined();
    expect(shareMeshFiles({ files: files.slice(0, 3) })[0].textureUrl).toBe(files[2].url);
  });
  it('preserves the recorded relative bite and millimetres through the shared basis rotation', () => {
    const lower = [...identity]; lower[7] = 8;
    const matrices = { upper: identity, lower };
    const result = shareMeshFiles({ files: [file('upper.obj', 'upper'), file('lower.obj', 'lower')],
      viewer_annotations: { mesh_alignment: { coordinate_frame: 'fussen_z_up', matrices } } });
    const point = new THREE.Vector3(3, 4, 5);
    const transformed = result.map((f) => point.clone().applyMatrix4(new THREE.Matrix4().set(...f.matrix)));
    expect(transformed[0].toArray()).toEqual([-3, 5, 4]);
    expect(transformed[0].distanceTo(transformed[1])).toBe(8);
    expect(identity).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
  it('rejects partial, scaled, reflected and malformed saved poses', () => {
    const files = [file('upper.obj', 'upper'), file('lower.obj', 'lower')];
    expect(() => shareMeshFiles({ files, viewer_annotations: { mesh_alignment: { matrices: { upper: identity } } } })).toThrow('incomplete');
    for (const scale of [2, -1, NaN]) {
      const matrix = [...identity]; matrix[0] = scale;
      expect(isRigidScanMatrix(matrix)).toBe(false);
    }
    expect(shareMeshFiles({ files })[0].matrix).toBeUndefined();
  });
});

describe('OBJ surface fidelity', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('retains both child surfaces, UVs and captured normals under a rigid pose', async () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 2\nv 1 0 2\nv 0 1 2\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 -1\no upper\nf 1/1/1 2/2/1 3/3/1\no lower\nf 4/1/1 5/2/1 6/3/1\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode(obj).buffer }));
    const matrix = [...identity]; matrix[3] = 10;
    const loaded = await loadOneFile({ url: 'https://scan.invalid/model.obj', fileName: 'upper.obj', matrix, textureUrl: 'https://scan.invalid/upper.jpg' });
    const geometry = loaded.geometry;
    expect(geometry.getAttribute('position').count).toBe(6);
    expect(geometry.getAttribute('uv').count).toBe(6);
    expect(geometry.getAttribute('uv').getX(1)).toBe(1);
    expect(geometry.getAttribute('normal').getZ(0)).toBe(-1);
    expect(geometry.getAttribute('position').getX(0)).toBe(10);
    expect(geometry.getAttribute('position').getZ(3)).toBe(2);
    expect(loaded.textureUrl).toBe('https://scan.invalid/upper.jpg');
    geometry.dispose();
  });
});
