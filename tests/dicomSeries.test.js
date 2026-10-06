import { describe, expect, it } from 'vitest';
import { dicomStudySeries, dicomFrameIds, orderDicomSeries } from '../src/lib/dicomSeries';
const image = (id, series = '1.2.3') => ({ id, storage_path: `${id}.dcm`, series_instance_uid: series, sop_instance_uid: `1.2.3.${id}`, instance_number: Number(id) });
describe('DICOM study browsing', () => {
  it('retains every series including scouts without mixing their images', () => {
    const groups = dicomStudySeries([{ ...image('1'), series_description: 'Scout' }, image('2', '1.2.4')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('1: Scout');
    expect(groups.map(group => group.files.length)).toEqual([1, 1]);
  });
  it('orders an oblique stack along its normal rather than filename or axial Z alone', () => {
    const files = [image('1'), image('2')].map((file, index) => ({ ...file, dicom_acquisition: {
      imageOrientationPatient: [0, 1, 0, 0, 0, 1], imagePositionPatient: [10 - index * 5, 0, 0], numberOfFrames: 1,
    } }));
    expect(orderDicomSeries(files).files.map(file => file.id)).toEqual(['2', '1']);
    files[1].dicom_acquisition.imageOrientationPatient = [1, 0, 0, 0, 1, 0];
    expect(orderDicomSeries(files).ordering).toBe('Instance number / filename');
  });
  it('expands frames using path-matched signing without altering the signed request token', () => {
    const files = [{ ...image('1'), dicom_acquisition: { numberOfFrames: 2 } }, image('2')];
    expect(dicomFrameIds(files, [
      { path: '2.dcm', signedUrl: 'https://example.invalid/2?token=b' },
      { path: '1.dcm', signedUrl: 'https://example.invalid/1?token=a' },
    ]).map(frame => frame.imageId)).toEqual([
      'wadouri:https://example.invalid/1?token=a&frame=1', 'wadouri:https://example.invalid/1?token=a&frame=2', 'wadouri:https://example.invalid/2?token=b',
    ]);
  });
  it('rejects duplicate identities, partial signing and malicious frame counts', () => {
    expect(() => dicomStudySeries([image('1'), image('1')])).toThrow('Duplicate');
    expect(() => dicomStudySeries([image('1'), { ...image('2'), series_instance_uid: null }])).toThrow('identities');
    expect(() => dicomFrameIds([image('1')], [])).toThrow('every DICOM');
    expect(() => dicomFrameIds([{ ...image('1'), dicom_acquisition: { numberOfFrames: 1e9 } }], [{ path: '1.dcm', signedUrl: 'https://example.invalid' }])).toThrow('frame count');
  });
});

it('sorts series numerically and distinguishes identical descriptions', () => {
  const groups = dicomStudySeries([
    { ...image('1','1.4'), series_number: 40, series_description: 'Repeated sequence' },
    { ...image('2','1.3'), series_number: 5, series_description: 'Repeated sequence' },
    { ...image('3','1.2'), series_number: 5, series_description: 'Repeated sequence' },
  ]);
  expect(groups.map(g => g.uid)).toEqual(['1.2','1.3','1.4']);
  expect(new Set(groups.map(g => g.label)).size).toBe(3);
});
