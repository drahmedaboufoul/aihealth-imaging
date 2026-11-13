import { describe, expect, it } from 'vitest';
import { parseMeshBuffer } from '../../src/workbench/core/parse';
import { writeBinaryPly, writeBinaryStl } from '../../src/workbench/core/export';
import { meshSha256 } from '../../src/workbench/core/hash';
import { isNeutralExportName, imageExportName, measurementsExportName, meshExportName } from '../../src/workbench/core/naming';
import { archMesh, toAsciiPly } from '../helpers/syntheticMesh';

const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('parsing (worker side)', () => {
  it('reads a binary STL soup into a welded indexed mesh, and round-trips our STL writer', async () => {
    const arch = archMesh({ nu: 40, nv: 10 });
    const stl = writeBinaryStl(arch);
    expect(stl.byteLength).toBe(84 + 50 * (arch.indices.length / 3));
    const header = new TextDecoder().decode(new Uint8Array(stl, 0, 80));
    expect(header).toMatch(/^aiHealth IOS workbench export/);
    const parsed = parseMeshBuffer(stl, 'any-name.stl');
    expect(parsed.format).toBe('stl');
    expect(parsed.topo.positions.length).toBe(arch.positions.length);
    expect(parsed.topo.indices.length).toBe(arch.indices.length);
    expect(parsed.display).toBeNull();
    // writing the parsed mesh again gives the same canonical geometry
    const again = parseMeshBuffer(writeBinaryStl(parsed.topo), 'x.stl');
    expect(await meshSha256(again.topo)).toBe(await meshSha256(parsed.topo));
  });

  it('reads ASCII STL through the three.js loader', () => {
    const ascii = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex 1 0 0\nvertex 1 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
    const parsed = parseMeshBuffer(buf(ascii), 'a.stl');
    expect(parsed.topo.indices.length / 3).toBe(2);
    expect(parsed.topo.positions.length / 3).toBe(4);
  });

  it('reads PLY (ASCII and our binary writer) with vertex colours', () => {
    const arch = archMesh({ nu: 20, nv: 6, colors: true });
    const ascii = parseMeshBuffer(buf(toAsciiPly(arch)), 'a.ply');
    expect(ascii.topo.colors).toBeTruthy();
    expect(ascii.topo.indices.length).toBe(arch.indices.length);
    const binary = parseMeshBuffer(writeBinaryPly(ascii.topo), 'b.ply');
    expect(binary.topo.positions.length).toBe(ascii.topo.positions.length);
    expect(binary.topo.colors![0]).toBeCloseTo(ascii.topo.colors![0], 2);
    const header = new TextDecoder().decode(new Uint8Array(writeBinaryPly(ascii.topo), 0, 120));
    expect(header).toMatch(/format binary_little_endian 1.0/);
  });

  it('keeps the Fussen byte-RGB OBJ colour path', () => {
    const obj = 'v 0 0 0 110 62 56\nv 1 0 0 255 180 0\nv 0 1 0 102 61 55\nf 1 2 3\n';
    const parsed = parseMeshBuffer(buf(obj), 'TextureMesh2_1.obj');
    expect(parsed.topo.colors).toBeTruthy();
    expect(Math.max(...parsed.topo.colors!)).toBeLessThanOrEqual(1);
  });

  it('keeps texture seams for display while welding topology by position', () => {
    // two triangles sharing an edge, but with different UVs on the shared vertices (a seam)
    const obj = [
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1 1 0',
      'vt 0 0', 'vt 1 0', 'vt 0 1', 'vt 0.5 0.5', 'vt 0.6 0.6', 'vt 1 1',
      'f 1/1 2/2 3/3', 'f 2/8 4/10 3/9', '',
    ].join('\n');
    const parsed = parseMeshBuffer(buf(obj), 'seam.obj');
    expect(parsed.topo.positions.length / 3).toBe(4);
    expect(parsed.display).not.toBeNull();
    expect(parsed.display!.positions.length / 3).toBe(6);
    expect(parsed.display!.indices.length).toBe(parsed.topo.indices.length);
    expect(parsed.displayToTopo!.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      const t = parsed.displayToTopo![i];
      for (let k = 0; k < 3; k++) expect(parsed.display!.positions[i * 3 + k]).toBe(parsed.topo.positions[t * 3 + k]);
    }
  });

  it('rejects unsupported formats and empty files with a readable message', () => {
    expect(() => parseMeshBuffer(new ArrayBuffer(10), 'scan.dcm')).toThrow(/Unsupported/);
    expect(() => parseMeshBuffer(buf('solid x\nendsolid x\n'), 'empty.stl')).toThrow(/no/i);
  });
});

describe('neutral export names', () => {
  const d = new Date(2026, 9, 19);
  it('follow scan-YYYY-MM-DD and measurements-YYYY-MM-DD', () => {
    expect(meshExportName('A', 2, 'stl', d)).toBe('scan-2026-10-19-a-v2.stl');
    expect(meshExportName('B', 0, 'ply', d)).toBe('scan-2026-10-19-b-v0.ply');
    expect(imageExportName('deviation', d)).toBe('scan-2026-10-19-deviation.png');
    expect(measurementsExportName(d)).toBe('measurements-2026-10-19.json');
    for (const n of [meshExportName('A', 2, 'stl', d), imageExportName('contacts', d), measurementsExportName(d)]) expect(isNeutralExportName(n)).toBe(true);
    expect(isNeutralExportName('John_Smith_upper.stl')).toBe(false);
    expect(isNeutralExportName('scan-2026-10-19-3f2a9c1e-uuid.stl')).toBe(true); // shape only; ids never reach it (slot letter is the only free part)
    expect(() => meshExportName('../etc', 1, 'stl', d)).not.toThrow();
    expect(meshExportName('../etc', 1, 'stl', d)).toBe('scan-2026-10-19-etc-v1.stl');
  });
});
