import { expect, test } from '@playwright/test';
import { deflateRawSync } from 'node:zlib';

// Minimal generated uncompressed DICOM. No patient data or external fixtures.
function dicom(instance: number, deflated: boolean) {
  const tags: Buffer[] = [];
  const text = (group: number, element: number, vr: string, value: string) => {
    let bytes = Buffer.from(value); if (bytes.length % 2) bytes = Buffer.concat([bytes, Buffer.from([vr === 'UI' ? 0 : 32])]);
    const h = Buffer.alloc(8); h.writeUInt16LE(group); h.writeUInt16LE(element, 2); h.write(vr, 4); h.writeUInt16LE(bytes.length, 6); tags.push(h, bytes);
  };
  const us = (element: number, value: number) => {
    const b = Buffer.alloc(10); b.writeUInt16LE(0x28); b.writeUInt16LE(element, 2); b.write('US', 4); b.writeUInt16LE(2, 6); b.writeUInt16LE(value, 8); tags.push(b);
  };
  text(2, 0x10, 'UI', deflated ? '1.2.840.10008.1.2.1.99' : '1.2.840.10008.1.2.1');
  text(8, 0x16, 'UI', '1.2.840.10008.5.1.4.1.1.7'); text(8, 0x18, 'UI', `1.2.3.4.${instance}`); text(8, 0x60, 'CS', 'OT');
  text(0x20, 0x0d, 'UI', '1.2.3'); text(0x20, 0x0e, 'UI', '1.2.3.4'); text(0x20, 0x13, 'IS', String(instance));
  us(2, 1); text(0x28, 4, 'CS', 'MONOCHROME2'); us(0x10, 16); us(0x11, 16); us(0x100, 8); us(0x101, 8); us(0x102, 7); us(0x103, 0);
  text(0x28, 0x1050, 'DS', '128'); text(0x28, 0x1051, 'DS', '256');
  const pixels = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const h = Buffer.alloc(12); h.writeUInt16LE(0x7fe0); h.writeUInt16LE(0x10, 2); h.write('OB', 4); h.writeUInt32LE(pixels.length, 8);
  const header = tags.splice(0, 2);
  const metaLength = Buffer.alloc(12); metaLength.writeUInt16LE(2); metaLength.write('UL', 4); metaLength.writeUInt16LE(4, 6); metaLength.writeUInt32LE(Buffer.concat(header).length, 8);
  const dataset = Buffer.concat([...tags, h, pixels]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), metaLength, ...header, deflated ? deflateRawSync(dataset) : dataset]);
}

for (const deflated of [false, true]) test(`${deflated ? 'deflated' : 'native'} DICOM renders and focused slider advances one frame per press`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  const payload = {
    study: { id: 'synthetic-study', study_type: 'other' }, source: 'patient', permission: 'view',
    signed_urls_expires_at: new Date(Date.now() + 600000).toISOString(),
    files: [1,2,3].map(n => ({ fileId: `synthetic-${n}`, fileKind: 'dicom', fileName: `${n}.dcm`,
      url: `data:application/dicom;base64,${dicom(n, deflated).toString('base64')}`, seriesInstanceUid: '1.2.3.4',
      sopInstanceUid: `1.2.3.4.${n}`, instanceNumber: n, dicomAcquisition: { numberOfFrames: 1 } })),
  };
  // Seed only a generated local share fixture; no real token, patient or network files.
  await page.addInitScript(data => sessionStorage.setItem('keyboard-regression', JSON.stringify(data)), payload);
  await page.goto('/viewer/dicom?share=keyboard-regression&readonly=1');
  const viewer = page;
  const slice = viewer.getByRole('slider', { name: 'Slice', exact: true });
  await expect(slice).toBeVisible();
  await slice.focus(); await slice.press('Home'); await expect(slice).toHaveAttribute('aria-valuenow', '1');
  await slice.press('ArrowRight'); await expect(slice).toHaveAttribute('aria-valuenow', '2');
  await slice.press('ArrowRight'); await expect(slice).toHaveAttribute('aria-valuenow', '3');
  await slice.press('ArrowLeft'); await expect(slice).toHaveAttribute('aria-valuenow', '2');
  const windowCenter = viewer.getByRole('slider', { name: 'Window Center', exact: true });
  await windowCenter.focus(); await windowCenter.press('ArrowRight');
  await expect(slice).toHaveAttribute('aria-valuenow', '2');
  const series = viewer.getByRole('combobox', { name: 'DICOM series' });
  await series.focus(); await series.press('ArrowRight');
  await expect(slice).toHaveAttribute('aria-valuenow', '2');
  expect(errors).toEqual([]);
});
