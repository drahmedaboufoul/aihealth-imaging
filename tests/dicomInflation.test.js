import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateRaw } from 'pako';
import dicomParser from 'dicom-parser';
import { inflateDicomDataSet, inflateDicomRaw, installDicomInflater } from '../src/lib/dicomInflation';

afterEach(() => vi.unstubAllGlobals());
function element(group, tag, vr, value) {
  const data = typeof value === 'number' ? [value & 255, value >> 8] : [...new TextEncoder().encode(value + (value.length % 2 ? '\0' : ''))];
  return [group & 255, group >> 8, tag & 255, tag >> 8, ...new TextEncoder().encode(vr), data.length & 255, data.length >> 8, ...data];
}
export function syntheticDeflatedDicom() {
  const meta = element(2,16,'UI','1.2.840.10008.1.2.1.99');
  const header = new Uint8Array([...new Array(128).fill(0), 68,73,67,77, 2,0,0,0,85,76,4,0,meta.length,0,0,0, ...meta]);
  const dataset = new Uint8Array([
    ...element(8,0x18,'UI','1.2.3.4.5'), ...element(8,0x60,'CS','OT'),
    ...element(0x20,0x0d,'UI','1.2.3'), ...element(0x20,0x0e,'UI','1.2.3.4'),
    ...element(0x28,0x10,'US',1), ...element(0x28,0x11,'US',2),
    0xe0,0x7f,0x10,0,79,66,0,0,2,0,0,0,42,84,
  ]);
  return new Uint8Array([...header, ...deflateRaw(dataset)]);
}

describe('bounded deflated DICOM support', () => {
  it('parses generated deflated source without viewer initialization or globals and preserves original bytes', () => {
    vi.stubGlobal('pako', undefined);
    const bytes = syntheticDeflatedDicom(), original = bytes.slice();
    const ds = dicomParser.parseDicom(bytes, { inflater: inflateDicomDataSet });
    expect(ds.uint16('x00280010')).toBe(1);
    expect(ds.uint16('x00280011')).toBe(2);
    expect(ds.string('x00020010')).toBe('1.2.840.10008.1.2.1.99');
    expect([...ds.byteArray.slice(ds.elements.x7fe00010.dataOffset)]).toEqual([42,84]);
    expect(bytes).toEqual(original);
    expect(globalThis.pako).toBeUndefined();
  });
  it('stops decoded output at its bound', () => {
    expect(() => inflateDicomRaw(deflateRaw(new Uint8Array(10000)), 1024)).toThrow(/decoded dataset limit/);
  });
  it('rejects truncated or corrupt deflate streams', () => {
    expect(() => inflateDicomRaw(new Uint8Array([255,255,255]))).toThrow(/Invalid|incomplete/);
  });
  it('installs only a missing browser inflater for the loader', () => {
    vi.stubGlobal('pako', undefined); installDicomInflater();
    expect(globalThis.pako.inflateRaw).toBe(inflateDicomRaw);
    expect([...globalThis.pako.inflateRaw(deflateRaw(new Uint8Array([4,2]))) ]).toEqual([4,2]);
  });
  it('preserves a host-provided pako without overwriting it', () => {
    const host = { inflateRaw: vi.fn() }; vi.stubGlobal('pako', host); installDicomInflater();
    expect(globalThis.pako).toBe(host);
  });
});
