/*
 * IOS workbench end-to-end tests with synthetic STL/PLY fixtures generated
 * here (no patient files): load two scans, align, deviation map, measure,
 * edit, export; contact map on two role-less meshes.
 *
 * Set WORKBENCH_SHOTS_DIR to save a screenshot of each feature.
 * Set WORKBENCH_PERF=1 to also run the 2M-triangle browser load check.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { archMesh, orientOutward, rigid, transformed, withBump } from '../helpers/syntheticMesh';
import { writeBinaryPly, writeBinaryStl } from '../../src/workbench/core/export';
import type { MeshData } from '../../src/workbench/core/types';

const SHOTS = process.env.WORKBENCH_SHOTS_DIR?.trim();

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iosw-e2e-'));
}

function write(dir: string, name: string, data: ArrayBuffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(data));
  return p;
}

/** Click grid points in a pane (centre first) until `done()` is true. */
async function clickUntil(page: Page, paneTestId: string, done: () => Promise<boolean>, maxClicks = 80): Promise<void> {
  const box = (await page.getByTestId(paneTestId).boundingBox())!;
  const pts: Array<[number, number]> = [];
  for (let r = 0; r <= 8; r++) for (let c = 0; c <= 10; c++) pts.push([box.x + box.width * (0.12 + 0.76 * (c / 10)), box.y + box.height * (0.12 + 0.7 * (r / 8))]);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  let clicks = 0;
  for (const [x, y] of pts) {
    if (await done()) return;
    if (clicks++ >= maxClicks) break;
    await page.mouse.click(x, y);
    await page.waitForTimeout(60);
  }
  if (!(await done())) throw new Error('could not hit the scan surface');
}

/** Hover grid points until the deviation readout shows a value; returns it. */
async function hoverReadout(page: Page): Promise<string> {
  const box = (await page.getByTestId('pane-left').boundingBox())!;
  for (let r = 1; r < 10; r++) for (let c = 1; c < 12; c++) {
    await page.mouse.move(box.x + (box.width * c) / 12, box.y + (box.height * r) / 10);
    const ro = page.getByTestId('hover-readout');
    if (await ro.isVisible().catch(() => false)) {
      const t = await ro.innerText();
      if (/mm/.test(t)) return t;
    }
  }
  throw new Error('no hover readout');
}

/** Minimal RGB PNG encoder for a synthetic texture (no image files checked in). */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (1 + width * 3) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** OBJ text for a mesh, with optional per-vertex byte RGB (Fussen style) or a planar UV map. */
function objText(mesh: MeshData, mode: 'byte-rgb' | 'uv'): string {
  const lines: string[] = [];
  const P = mesh.positions;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) { minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]); minZ = Math.min(minZ, P[i + 2]); maxZ = Math.max(maxZ, P[i + 2]); }
  for (let v = 0; v < P.length / 3; v++) {
    const xyz = `${P[v * 3].toFixed(4)} ${P[v * 3 + 1].toFixed(4)} ${P[v * 3 + 2].toFixed(4)}`;
    lines.push(mode === 'byte-rgb' ? `v ${xyz} ${200 + (v % 50)} ${150} ${140}` : `v ${xyz}`);
  }
  if (mode === 'uv') for (let v = 0; v < P.length / 3; v++) lines.push(`vt ${((P[v * 3] - minX) / (maxX - minX)).toFixed(5)} ${((P[v * 3 + 2] - minZ) / (maxZ - minZ)).toFixed(5)}`);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t] + 1, mesh.indices[t + 1] + 1, mesh.indices[t + 2] + 1];
    lines.push(mode === 'uv' ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
  }
  return `${lines.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
}

function guardPage(page: Page) {
  const errors: string[] = [];
  const offOrigin: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (req) => {
    const u = new URL(req.url());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && !['127.0.0.1', 'localhost'].includes(u.hostname)) offOrigin.push(u.origin);
  });
  return { errors, offOrigin };
}

test.describe('IOS workbench', () => {
  test.describe.configure({ timeout: 180_000 });

  test('loads two scans, aligns them, maps deviation, measures, edits and exports', async ({ page }) => {
    const guard = guardPage(page);
    const dir = tmpDir();
    const arch = archMesh({ nu: 240, nv: 60 });
    // visit B: same arch with a 0.18 mm local build-up, displaced by a small rigid motion
    const visitB = transformed(withBump(arch, [0, 12], 5, 0.18), rigid([0.2, 1, 0.1], 2.5, [0.5, -0.3, 0.4]));
    const fa = write(dir, 'visit-a.stl', writeBinaryStl(arch));
    const fb = write(dir, 'visit-b.ply', writeBinaryPly(visitB));

    await page.goto('/viewer/ios/workbench');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await shot(page, '00-empty');
    await page.getByTestId('file-input').setInputFiles([fa, fb]);
    await expect(page.getByTestId('scan-status-A')).toContainText('ready', { timeout: 60_000 });
    await expect(page.getByTestId('scan-status-B')).toContainText('ready', { timeout: 60_000 });
    await expect(page.getByTestId('load-stats-A')).toContainText('BVH');

    // layouts: side by side with linked cameras, overlay with per-mesh colour/opacity
    await page.keyboard.press('2');
    await expect(page.getByTestId('pane-right')).toBeVisible();
    await expect(page.getByTestId('link-cameras')).toContainText('Linked');
    await shot(page, '01-side-by-side-linked');
    // linked: rotating the left pane moves the right pane; unlinked: it does not
    const right = page.getByTestId('pane-right');
    const leftBox = (await page.getByTestId('pane-left').boundingBox())!;
    const drag = async () => {
      await page.mouse.move(leftBox.x + leftBox.width * 0.5, leftBox.y + leftBox.height * 0.5);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(leftBox.x + leftBox.width * 0.7, leftBox.y + leftBox.height * 0.35, { steps: 8 });
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(300);
    };
    const before = await right.screenshot();
    await drag();
    const linkedAfter = await right.screenshot();
    expect(linkedAfter.equals(before)).toBe(false);
    await page.keyboard.press('l');
    await expect(page.getByTestId('link-cameras')).toContainText('Unlinked');
    await drag();
    expect((await right.screenshot()).equals(linkedAfter)).toBe(true);
    await page.keyboard.press('l');
    await page.keyboard.press('3');
    await expect(page.getByTestId('pane-right')).toHaveCount(0);
    await page.getByTestId('opacity-B').fill('0.6');
    await shot(page, '02-overlay');

    // alignment: ICP -> draft -> undo -> ICP -> accept
    await page.getByTestId('tool-align').click();
    await page.getByTestId('run-icp').click();
    await expect(page.getByTestId('icp-report')).toBeVisible({ timeout: 60_000 });
    const rms = parseFloat(await page.getByTestId('icp-rms').innerText());
    expect(rms).toBeLessThan(0.05);
    await expect(page.getByTestId('align-status')).toContainText('Draft');
    await shot(page, '03-alignment-draft');
    await page.getByTestId('align-undo').click();
    await expect(page.getByTestId('align-status')).toHaveCount(0);
    await page.getByTestId('run-icp').click();
    await expect(page.getByTestId('align-status')).toContainText('Draft', { timeout: 60_000 });
    await page.getByTestId('align-reviewer').fill('Dr Test');
    await page.getByTestId('align-accept').click();
    await expect(page.getByTestId('align-status')).toContainText('Accepted');

    // deviation map
    await page.keyboard.press('d');
    await page.getByTestId('run-deviation').click();
    await expect(page.getByTestId('deviation-histogram')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('deviation-legend')).toBeVisible();
    const within = parseFloat(await page.getByTestId('dev-band-0.05').innerText());
    expect(within).toBeGreaterThan(70);
    const readout = await hoverReadout(page);
    expect(readout).toMatch(/[+-]?\d+\.\d{3} mm|no counterpart/);
    await page.getByTestId('dev-tol-0.1').click();
    await shot(page, '04-deviation-map');

    // measurement: distance between two picked points
    await page.keyboard.press('m');
    await page.getByTestId('measure-mode-distance').click();
    await clickUntil(page, 'pane-left', async () => (await page.getByTestId('measurement-item').count()) >= 1);
    await expect(page.getByTestId('measurement-item').first()).toContainText('mm');
    await shot(page, '05-measure-distance');
    const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('measure-export').click()]);
    expect(jsonDl.suggestedFilename()).toMatch(/^measurements-\d{4}-\d{2}-\d{2}\.json$/);
    const json = fs.readFileSync(await jsonDl.path()!, 'utf8');
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('aihealth.ios-workbench.measurements/v1');
    expect(parsed.measurements).toHaveLength(1);
    expect(json).not.toContain('visit-a');
    expect(json).not.toContain('visit-b');

    // cross-section with a 2D profile
    await page.keyboard.press('s');
    await clickUntil(page, 'pane-left', async () => (await page.getByTestId('section-profile').count()) > 0);
    await expect(page.getByTestId('section-profile')).toBeVisible();
    await shot(page, '06-cross-section');

    // edit: decimate scan A -> new version with lineage
    await page.keyboard.press('e');
    await page.getByTestId('edit-target').selectOption('A');
    await page.getByTestId('decimate-target').fill('8000');
    await page.getByTestId('decimate').click();
    await expect(page.getByTestId('notice')).toContainText('A.v1', { timeout: 60_000 });
    await page.keyboard.press('v');
    await expect(page.getByTestId('version-A.v1')).toContainText('decimate');
    await expect(page.getByTestId('version-A.v0')).toContainText('original');
    await page.getByTestId('verify-A').click();
    await expect(page.getByTestId('verify-result-A')).toContainText('verified');
    await shot(page, '07-versions');

    // exports: STL of the current version, PLY, PNG
    await page.keyboard.press('x');
    await page.getByTestId('export-slot').selectOption('A');
    const [stlDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-stl').click()]);
    expect(stlDl.suggestedFilename()).toMatch(/^scan-\d{4}-\d{2}-\d{2}-a-v1\.stl$/);
    const stl = fs.readFileSync(await stlDl.path()!);
    const tris = stl.readUInt32LE(80);
    expect(tris).toBeLessThanOrEqual(8000);
    expect(stl.length).toBe(84 + 50 * tris);
    const [plyDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-ply').click()]);
    expect(plyDl.suggestedFilename()).toMatch(/^scan-\d{4}-\d{2}-\d{2}-a-v1\.ply$/);
    const [pngDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-png').click()]);
    expect(pngDl.suggestedFilename()).toMatch(/^scan-\d{4}-\d{2}-\d{2}-(view|deviation|contacts)\.png$/);
    const png = fs.readFileSync(await pngDl.path()!);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    if (SHOTS) fs.copyFileSync(await pngDl.path()!, path.join(SHOTS, '08-exported-snapshot.png'));

    expect(guard.errors, 'uncaught page errors').toEqual([]);
    expect(guard.offOrigin, 'requests that left this machine').toEqual([]);
  });

  test('contact map works on two meshes without role names and stays a draft until accepted', async ({ page }) => {
    const guard = guardPage(page);
    const dir = tmpDir();
    const lower = archMesh({ nu: 200, nv: 50 });
    let maxY = -Infinity;
    for (let i = 1; i < lower.positions.length; i += 3) maxY = Math.max(maxY, lower.positions[i]);
    // upper = mirrored lower, lowered so the highest cusps overlap by 0.05 mm
    const upper: MeshData = { positions: lower.positions.slice(), indices: lower.indices.slice(), colors: null };
    for (let i = 1; i < upper.positions.length; i += 3) upper.positions[i] = 2 * maxY - 0.05 - upper.positions[i];
    orientOutward(upper, [0, -1, 0]);
    const f1 = write(dir, 'scan-1.ply', writeBinaryPly(upper));
    const f2 = write(dir, 'scan-2.ply', writeBinaryPly(lower));

    await page.goto('/viewer/ios/workbench');
    await page.getByTestId('file-input').setInputFiles([f1, f2]);
    await expect(page.getByTestId('scan-status-B')).toContainText('ready', { timeout: 60_000 });
    await page.keyboard.press('c');
    await page.getByTestId('contact-upper').selectOption('A');
    await page.getByTestId('contact-lower').selectOption('B');
    await page.getByTestId('run-contacts').click();
    await expect(page.getByTestId('contact-upper-summary')).toBeVisible({ timeout: 60_000 });
    const area = parseFloat(await page.getByTestId('contact-upper-summary-contact').innerText());
    expect(area).toBeGreaterThan(0);
    await expect(page.getByTestId('contact-status')).toContainText('Draft');
    await expect(page.getByTestId('contact-legend')).toBeVisible();
    await shot(page, '09-contact-map-draft');
    await page.getByTestId('contact-reviewer').fill('Dr Test');
    await page.getByTestId('contact-accept').click();
    await expect(page.getByTestId('contact-status')).toContainText('Accepted');
    await page.keyboard.press('2');
    await shot(page, '10-contact-map-accepted-side-by-side');
    expect(guard.errors).toEqual([]);
    expect(guard.offOrigin).toEqual([]);
  });

  test('landmark pre-alignment, lasso area, lasso trim, hole fill and smoothing', async ({ page }) => {
    const guard = guardPage(page);
    const dir = tmpDir();
    const arch = archMesh({ nu: 200, nv: 50 });
    const moved = transformed(arch, rigid([0.3, 1, 0.2], 6, [1.2, -0.6, 0.8]));
    const fa = write(dir, 'first.stl', writeBinaryStl(arch));
    const fb = write(dir, 'second.stl', writeBinaryStl(moved));
    await page.goto('/viewer/ios/workbench');
    await page.getByTestId('file-input').setInputFiles([fa, fb]);
    await expect(page.getByTestId('scan-status-B')).toContainText('ready', { timeout: 60_000 });

    // landmarks: 3 picks on the fixed scan (left pane), 3 on the moving scan (right pane)
    await page.keyboard.press('2');
    await page.keyboard.press('a');
    await page.getByTestId('lm-fixed').click();
    await clickUntil(page, 'pane-left', async () => (await page.getByTestId('lm-fixed').innerText()).includes('3/3'));
    await clickUntil(page, 'pane-right', async () => (await page.getByTestId('lm-moving').innerText()).includes('3/3'));
    await shot(page, '12-landmarks-picked');
    await page.getByTestId('lm-apply').click();
    await expect(page.getByTestId('align-history')).toContainText('3-point landmarks');
    await expect(page.getByTestId('align-status')).toContainText('Draft');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('align-status')).toHaveCount(0);

    // lasso area measurement in the single view
    await page.keyboard.press('1');
    await page.keyboard.press('m');
    await page.getByTestId('measure-mode-area').click();
    const box = (await page.getByTestId('pane-left').boundingBox())!;
    const lasso = async () => {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = Math.min(box.width, box.height) * 0.3;
      await page.mouse.move(cx + r, cy);
      await page.mouse.down();
      for (let i = 1; i <= 24; i++) await page.mouse.move(cx + r * Math.cos((i / 24) * 2 * Math.PI), cy + r * Math.sin((i / 24) * 2 * Math.PI));
      await page.mouse.up();
    };
    await lasso();
    await expect(page.getByTestId('measurement-item').first()).toContainText('mm²', { timeout: 30_000 });

    // lasso trim -> preview -> delete selection -> new version
    await page.keyboard.press('Escape');
    await page.keyboard.press('e');
    await page.getByTestId('edit-target').selectOption('A');
    await page.getByTestId('trim-lasso-left').click();
    await lasso();
    await expect(page.getByTestId('trim-selected')).not.toHaveText('0', { timeout: 30_000 });
    await shot(page, '13-trim-preview');
    await page.getByTestId('trim-delete').click();
    await expect(page.getByTestId('notice')).toContainText('A.v1', { timeout: 60_000 });

    // fill the hole the trim made? (the lasso hole is open to the rim or interior) -> fill + smooth create versions
    await page.getByTestId('fill-max').fill('2000');
    await page.getByTestId('fill-holes').click();
    await expect(page.getByTestId('notice')).toContainText('A.v2', { timeout: 60_000 });
    await page.getByTestId('smooth').click();
    await expect(page.getByTestId('notice')).toContainText('A.v3', { timeout: 60_000 });
    await page.keyboard.press('v');
    await expect(page.getByTestId('version-A.v3')).toContainText('smooth');
    await expect(page.getByTestId('version-A.v2')).toContainText('fill-holes');
    await expect(page.getByTestId('version-A.v1')).toContainText('trim-lasso');
    await page.getByTestId('verify-A').click();
    await expect(page.getByTestId('verify-result-A')).toContainText('verified');
    await shot(page, '14-edit-lineage');
    expect(guard.errors).toEqual([]);
    expect(guard.offOrigin).toEqual([]);
  });

  test('keeps the Fussen colour path: byte-RGB OBJ and OBJ + texture image', async ({ page }) => {
    const guard = guardPage(page);
    const dir = tmpDir();
    const arch = archMesh({ nu: 80, nv: 20 });
    const fColour = path.join(dir, 'TextureMesh1_1.obj');
    fs.writeFileSync(fColour, objText(arch, 'byte-rgb'));
    const fTex = path.join(dir, 'TextureMesh2_1.obj');
    fs.writeFileSync(fTex, objText(transformed(arch, rigid([0, 1, 0], 0, [0, -12, 0])), 'uv'));
    const fImg = path.join(dir, 'FussenTexture2_1.png');
    fs.writeFileSync(fImg, png(64, 64, (x, y) => [180 + (x % 8) * 8, 120 + (y % 16) * 6, 110]));
    await page.goto('/viewer/ios/workbench');
    await page.getByTestId('file-input').setInputFiles([fColour, fTex, fImg]);
    await expect(page.getByTestId('scan-status-A')).toContainText('vertex colour', { timeout: 60_000 });
    await expect(page.getByTestId('scan-status-B')).toContainText('texture', { timeout: 60_000 });
    await shot(page, '15-fussen-colour-and-texture');
    expect(guard.errors).toEqual([]);
    expect(guard.offOrigin).toEqual([]);
  });

  test('keyboard help lists the shortcuts', async ({ page }) => {
    await page.goto('/viewer/ios/workbench');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByTestId('help-overlay')).toContainText('Deviation map');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-overlay')).toHaveCount(0);
  });
});

test.describe('IOS workbench performance (opt-in)', () => {
  test.skip(process.env.WORKBENCH_PERF !== '1', 'set WORKBENCH_PERF=1');
  test.describe.configure({ timeout: 600_000 });

  test('2M-triangle scan loads in the worker while the main thread keeps painting', async ({ page }) => {
    const dir = tmpDir();
    const big = archMesh({ nu: 2000, nv: 500 });
    const file = write(dir, 'synthetic-2m.stl', writeBinaryStl(big));
    await page.goto('/viewer/ios/workbench');
    await page.evaluate(() => {
      const w = window as unknown as { __perf: { gaps: number[]; long: number[]; stop: boolean } };
      w.__perf = { gaps: [], long: [], stop: false };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            w.__perf.long.push(e.duration);
            ((w.__perf as unknown as { longAt?: number[] }).longAt ??= []).push(Math.round(e.startTime));
          }
        }).observe({ type: 'longtask', buffered: false });
      } catch { /* longtask not supported */ }
      let last = performance.now();
      const loop = (t: number) => {
        w.__perf.gaps.push(t - last);
        if (t - last > 50) ((w.__perf as unknown as { slow?: string[] }).slow ??= []).push(`${Math.round(last)}+${Math.round(t - last)}`);
        last = t;
        if (!w.__perf.stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const t0 = Date.now();
    await page.getByTestId('file-input').setInputFiles(file);
    await expect(page.getByTestId('scan-status-A')).toContainText('ready', { timeout: 300_000 });
    const wallMs = Date.now() - t0;
    const stats = JSON.parse((await page.getByTestId('load-stats-A').getAttribute('data-load-stats'))!);
    const perf = await page.evaluate(() => {
      const w = window as unknown as { __perf: { gaps: number[]; long: number[]; stop: boolean } };
      w.__perf.stop = true;
      const g = w.__perf.gaps.slice(1).sort((a, b) => a - b);
      return {
        frames: g.length,
        p50FrameMs: g[Math.floor(g.length * 0.5)],
        p95FrameMs: g[Math.floor(g.length * 0.95)],
        maxFrameMs: g[g.length - 1],
        longTasks: w.__perf.long.length,
        longestTaskMs: Math.max(0, ...w.__perf.long),
        marks: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('iosw:')).map((m) => `${m.name}@${Math.round(m.startTime)}`),
        longAt: (w.__perf as unknown as { longAt?: number[] }).longAt ?? [],
        long: w.__perf.long.map((d) => Math.round(d)),
        slowFrames: (w.__perf as unknown as { slow?: string[] }).slow ?? [],
      };
    });
    console.log(`PERF2M-BROWSER ${JSON.stringify({ wallMs, stats, ...perf })}`);
    await shot(page, '11-2m-triangles-loaded');
  });
});
