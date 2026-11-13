import { describe, expect, it } from 'vitest';
import { canonicalJson, meshSha256, Sha256, sha256Hex } from '../../src/workbench/core/hash';
import { VersionStore, verifyLineage } from '../../src/workbench/core/versions';
import { planeGrid } from '../helpers/syntheticMesh';

const enc = (s: string) => new TextEncoder().encode(s);

describe('SHA-256', () => {
  it('matches the FIPS 180-2 vectors (JS fallback and Web Crypto)', async () => {
    const vectors: Array<[string, string]> = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ];
    for (const [msg, hex] of vectors) {
      expect(new Sha256().update(enc(msg)).digestHex()).toBe(hex);
      expect(await sha256Hex(enc(msg))).toBe(hex);
    }
    // streaming across block boundaries equals one-shot
    const long = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
    const h = new Sha256();
    for (let i = 0; i < long.length; i += 37) h.update(long.subarray(i, i + 37));
    expect(h.digestHex()).toBe(await sha256Hex(long));
    expect(await sha256Hex(long.subarray(0, 500), long.subarray(500))).toBe(await sha256Hex(long));
  });

  it('canonical JSON ignores key order and undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined, b: 'x' } })).toBe('{"a":{"b":"x","d":[1,2]},"b":1}');
    expect(canonicalJson({ a: new Float32Array([0.5, 1]) })).toBe('{"a":[0.5,1]}');
  });

  it('mesh hash is stable and changes with any geometry change', async () => {
    const a = planeGrid({ n: 8 });
    const h1 = await meshSha256(a);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await meshSha256(planeGrid({ n: 8 }))).toBe(h1);
    const b = planeGrid({ n: 8 });
    b.positions[4] += 1e-3;
    expect(await meshSha256(b)).not.toBe(h1);
    const c = planeGrid({ n: 8 });
    [c.indices[0], c.indices[1]] = [c.indices[1], c.indices[0]];
    expect(await meshSha256(c)).not.toBe(h1);
  });
});

describe('version lineage', () => {
  it('keeps the original immutable and links each edit to its parent', async () => {
    const store = new VersionStore('A');
    const v0 = await store.addOriginal({ outputSha256: 'a'.repeat(64), sourceFileSha256: 'b'.repeat(64), vertices: 10, triangles: 8 });
    expect(v0.id).toBe('A.v0');
    expect(Object.isFrozen(v0)).toBe(true);
    await expect(store.addOriginal({ outputSha256: 'c'.repeat(64), sourceFileSha256: 'd'.repeat(64), vertices: 1, triangles: 1 })).rejects.toThrow(/immutable/);
    const v1 = await store.addDerived({ parentId: 'A.v0', op: 'decimate', params: { targetTriangles: 4 }, outputSha256: 'e'.repeat(64), vertices: 6, triangles: 4 });
    const v2 = await store.addDerived({ parentId: v1.id, op: 'smooth', params: { method: 'taubin', iterations: 3 }, outputSha256: 'f'.repeat(64), vertices: 6, triangles: 4 });
    const v3 = await store.addDerived({ parentId: 'A.v0', op: 'fill-holes', params: { maxEdges: 50, keepLargestBoundary: true }, outputSha256: '1'.repeat(64), vertices: 10, triangles: 9 });
    expect(store.lineage(v2.id)).toEqual(['A.v0', 'A.v1', 'A.v2']);
    expect(store.lineage(v3.id)).toEqual(['A.v0', 'A.v3']);
    expect(store.original).toBe(v0);
    expect((await verifyLineage(store.list)).ok).toBe(true);
    await expect(store.addDerived({ parentId: 'A.v9', op: 'smooth', params: {}, outputSha256: '2'.repeat(64), vertices: 1, triangles: 1 })).rejects.toThrow(/Unknown parent/);
  });

  it('parameter hash binds op, params and the parent output hash', async () => {
    const store = new VersionStore('B');
    await store.addOriginal({ outputSha256: 'a'.repeat(64), sourceFileSha256: 'b'.repeat(64), vertices: 3, triangles: 1 });
    const v1 = await store.addDerived({ parentId: 'B.v0', op: 'decimate', params: { targetTriangles: 1 }, outputSha256: 'c'.repeat(64), vertices: 3, triangles: 1 });
    const other = new VersionStore('B');
    await other.addOriginal({ outputSha256: 'd'.repeat(64), sourceFileSha256: 'b'.repeat(64), vertices: 3, triangles: 1 });
    const w1 = await other.addDerived({ parentId: 'B.v0', op: 'decimate', params: { targetTriangles: 1 }, outputSha256: 'c'.repeat(64), vertices: 3, triangles: 1 });
    expect(v1.paramsSha256).not.toBe(w1.paramsSha256);
    const tampered = store.toPersistable();
    tampered[1].params = { targetTriangles: 2 };
    const check = await verifyLineage(tampered);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toMatch(/parameter hash mismatch/);
    const orphan = store.toPersistable();
    orphan[1].parentId = 'B.v7';
    expect((await verifyLineage(orphan)).ok).toBe(false);
  });
});
