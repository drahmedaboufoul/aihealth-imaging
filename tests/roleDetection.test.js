import { describe, it, expect } from 'vitest';
import { detectScanRole, ROLE_STYLE, ROLE_TO_SETTING } from '../src/components/ios-viewer/utils/roleDetection';

describe('detectScanRole — vendor filename heuristics', () => {
  it('detects upper-jaw naming variants as maxilla', () => {
    for (const name of [
      'upperjaw.stl', 'upper-jaw.stl', 'upper_arch.ply', 'UpperArch.obj',
      'maxilla.stl', 'Maxillar.stl', 'max_scan.stl', 'top_jaw.stl', 'U.stl',
    ]) {
      expect(detectScanRole(name), name).toBe('maxilla');
    }
  });

  it('detects lower-jaw naming variants as mandible', () => {
    for (const name of [
      'lowerjaw.stl', 'lower-jaw.stl', 'lower_arch.ply', 'LowerArch.obj',
      'mandible.stl', 'Mandibular.stl', 'mand_scan.stl', 'bottom_jaw.stl', 'L.stl',
    ]) {
      expect(detectScanRole(name), name).toBe('mandible');
    }
  });

  it('detects bite/occlusion naming variants', () => {
    for (const name of [
      'occlusion.stl', 'occlusion1.stl', 'bite.stl', 'bite_left.stl',
      'bite-r.ply', 'in_occlusion.stl', 'registered.stl', 'InOcclusion.obj',
    ]) {
      expect(detectScanRole(name), name).toBe('occlusion');
    }
  });

  it('prioritises occlusion over jaw keywords in combined names', () => {
    expect(detectScanRole('in_occlusion_upper.stl')).toBe('occlusion');
    expect(detectScanRole('bite_lower.stl')).toBe('occlusion');
  });

  it('only matches the basename, ignoring directory components', () => {
    // Posix and Windows-style paths
    expect(detectScanRole('cases/12345/lowerjaw.stl')).toBe('mandible');
    expect(detectScanRole('C:\\scans\\upperjaw.stl')).toBe('maxilla');
  });

  it('returns unknown for unrecognised or missing names', () => {
    expect(detectScanRole('scan001.stl')).toBe('unknown');
    expect(detectScanRole('model.ply')).toBe('unknown');
    expect(detectScanRole('')).toBe('unknown');
    expect(detectScanRole(null)).toBe('unknown');
    expect(detectScanRole(undefined)).toBe('unknown');
  });
});

describe('ROLE_STYLE / ROLE_TO_SETTING wiring', () => {
  const ROLES = ['maxilla', 'mandible', 'occlusion', 'unknown'];

  it('provides a complete style for every role detectScanRole can return', () => {
    for (const role of ROLES) {
      const style = ROLE_STYLE[role];
      expect(style, role).toBeDefined();
      expect(style.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(style.label).toBeTruthy();
      expect(style.roughness).toBeGreaterThan(0);
    }
  });

  it('maps every role to existing visibility/opacity setting keys', () => {
    for (const role of ROLES) {
      const setting = ROLE_TO_SETTING[role];
      expect(setting, role).toBeDefined();
      expect(setting.visible).toMatch(/Visible$/);
      expect(setting.opacity).toMatch(/Opacity$/);
    }
    // unknown deliberately falls back to the maxilla toggles
    expect(ROLE_TO_SETTING.unknown).toEqual(ROLE_TO_SETTING.maxilla);
  });
});
