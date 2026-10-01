import { describe, it, expect } from 'vitest';
import { LECTURE_FILES, isLectureFixture } from '../src/lib/lectureFixture';
import { readFileSync } from 'node:fs';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

describe('fixed public lecture model', () => {
  it('requires the exact lecture selector and ignores arbitrary storage inputs', () => {
    expect(isLectureFixture(new URLSearchParams('lecture=1&study=private&path=private'))).toBe(true);
    expect(isLectureFixture(new URLSearchParams('lecture=true'))).toBe(false);
    expect(LECTURE_FILES.map(f=>f.url)).toEqual(['/lecture/teaching-color-upper.ply','/lecture/teaching-color-lower.ply']);
    expect(Object.isFrozen(LECTURE_FILES)).toBe(true);
  });
  it('branches to the fixed fixture before any clinical lookup', () => {
    const source=readFileSync(new URL('../src/pages/IOSViewerPage.jsx',import.meta.url),'utf8');
    const effect=source.slice(source.indexOf('let cancelled = false;'));
    expect(effect.indexOf('if (isLecture)')).toBeLessThan(effect.indexOf('if (shareKey)'));
    expect(effect.indexOf('if (isLecture)')).toBeLessThan(effect.indexOf('supabase.auth.getSession'));
  });
  it('ships full PLY meshes with captured non-uniform colour and neutral metadata', () => {
    for(const f of LECTURE_FILES){
      const bytes=readFileSync(new URL('../public'+f.url,import.meta.url));
      const header=bytes.subarray(0,bytes.indexOf('end_header')).toString('ascii');
      expect(header.match(/^comment .*$/gm)).toEqual([expect.stringMatching(/^comment Public Primescan teaching scan - (upper|lower)$/)]);
      const geometry=new PLYLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
      const colours=geometry.getAttribute('color');
      expect(geometry.getAttribute('position').count).toBeGreaterThan(100000);
      expect(colours.count).toBe(geometry.getAttribute('position').count);
      expect(geometry.index.count).toBeGreaterThan(300000);
      const samples=new Set();
      for(let i=0;i<colours.count;i+=97){
        const rgb=[colours.getX(i),colours.getY(i),colours.getZ(i)];
        expect(rgb.every(c=>Number.isFinite(c)&&c>=0&&c<=1)).toBe(true);
        samples.add(rgb.map(c=>Math.round(c*255)).join(','));
      }
      expect(samples.size).toBeGreaterThan(100);
      geometry.dispose();
    }
  });
});
