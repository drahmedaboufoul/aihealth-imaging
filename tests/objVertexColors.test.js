// @vitest-environment node
import { expect, it } from 'vitest';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { Color, SRGBColorSpace } from 'three';
import { normalizeObjVertexColors } from '../src/lib/objVertexColors';

const obj = colors => `mtllib scan.mtl\no upper\nv 1.25 -2 3 ${colors[0]}\nv 4 5 6 ${colors[1]}\nv 7 8 9 ${colors[2]}\nvt 0.1 0.2\nvt 0.3 0.4\nvt 0.5 0.6\nvn 0 0 1\nusemtl teeth\nf 1/1/1 2/2/1 3/3/1\n`;
const mesh = text => new OBJLoader().parse(text).children[0].geometry;

it('decodes scanner byte colours before sRGB conversion, preserving geometry and UVs', () => {
  const source = obj(['110 62 56','102 61 55','255 180 0']);
  const before = mesh(source), after = mesh(normalizeObjVertexColors(source));
  expect(after.getAttribute('position').array).toEqual(before.getAttribute('position').array);
  expect(after.getAttribute('uv').array).toEqual(before.getAttribute('uv').array);
  expect(after.getAttribute('normal').array).toEqual(before.getAttribute('normal').array);
  const expected = new Color().setRGB(110/255,62/255,56/255,SRGBColorSpace);
  expect(after.getAttribute('color').getX(0)).toBeCloseTo(expected.r,6);
  expect(after.getAttribute('color').getY(0)).toBeCloseTo(expected.g,6);
  expect(after.getAttribute('color').getZ(0)).toBeCloseTo(expected.b,6);
  expect(Math.max(...after.getAttribute('color').array)).toBeLessThanOrEqual(1);
  expect(Math.max(...before.getAttribute('color').array)).toBeGreaterThan(1000);
});

it('leaves normalized colours, uncoloured geometry and non-vertex records untouched', () => {
  const fractional = obj(['0.4 0.2 0.1','0 0 0','1 1 1']);
  expect(normalizeObjVertexColors(fractional)).toBe(fractional);
  const plain = 'v 123 245 36\nv 4 5 6 1\nvn 0 0 1\nvt 0.1 0.2\nf 1 2 3\n';
  expect(normalizeObjVertexColors(plain)).toBe(plain);
});

it('uses one scale for the whole file, including dark byte colours and multiple objects', () => {
  const source = 'v 1 2 3 0 1 0\r\no next\r\n  v 4 5 6 255 128 64 # source\r\n';
  const result = normalizeObjVertexColors(source);
  expect(result).toBe(`v 1 2 3 0 ${1/255} 0\r\no next\r\n  v 4 5 6 1 ${128/255} ${64/255} # source\r\n`);
  expect(normalizeObjVertexColors(result)).toBe(result);
});

it('does not guess an encoding for invalid or out-of-range source colours', () => {
  for (const value of ['256 0 0','NaN 0 0','-1 0 0']) {
    const source=obj(['110 62 56',value,'255 180 0']);
    expect(normalizeObjVertexColors(source)).toBe(source);
  }
});
