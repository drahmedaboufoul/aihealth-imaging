import { describe, it, expect } from 'vitest';
import { LECTURE_FILES, isLectureFixture } from '../src/lib/lectureFixture';
import { readFileSync } from 'node:fs';

describe('fixed public lecture model', () => {
  it('requires the exact lecture selector and ignores arbitrary storage inputs', () => {
    expect(isLectureFixture(new URLSearchParams('lecture=1&study=private&path=private'))).toBe(true);
    expect(isLectureFixture(new URLSearchParams('lecture=true'))).toBe(false);
    expect(LECTURE_FILES.map(f=>f.url)).toEqual(['/lecture/teaching-upper.stl','/lecture/teaching-lower.stl']);
    expect(Object.isFrozen(LECTURE_FILES)).toBe(true);
  });
  it('branches to the fixed fixture before any clinical lookup', () => {
    const source=readFileSync(new URL('../src/pages/IOSViewerPage.jsx',import.meta.url),'utf8');
    const effect=source.slice(source.indexOf('let cancelled = false;'));
    expect(effect.indexOf('if (isLecture)')).toBeLessThan(effect.indexOf('if (shareKey)'));
    expect(effect.indexOf('if (isLecture)')).toBeLessThan(effect.indexOf('supabase.auth.getSession'));
  });
  it('uses valid binary STL with neutral metadata headers', () => {
    for(const f of LECTURE_FILES){
      const bytes=readFileSync(new URL('../public'+f.url,import.meta.url));
      expect(bytes.length).toBe(84+50*bytes.readUInt32LE(80));
      expect(bytes.subarray(0,80).toString().replaceAll('\u0000','')).toMatch(/^Lecture teaching geometry - (upper|lower)$/);
    }
  });
});
