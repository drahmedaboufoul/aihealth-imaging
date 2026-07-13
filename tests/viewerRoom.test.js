import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  packState,
  statesEqual,
  throttle,
  roomChannelName,
  cbctRoomId,
  serialize2DState,
  apply2DState,
  serializeCbctState,
  applyCbctState,
} from '../src/lib/viewerRoom';

describe('packState', () => {
  it('rounds + keeps only finite/defined fields', () => {
    const s = packState({
      idx: 3.4, voi: { lower: 10.7, upper: 400.2 }, invert: true,
      rotation: 90, flipH: false, flipV: true, zoom: 1.23456, pan: [4.567, -2.019],
    });
    expect(s).toEqual({
      idx: 3, voi: { lower: 11, upper: 400 }, invert: true,
      rotation: 90, flipH: false, flipV: true, zoom: 1.2346, pan: [4.57, -2.02],
    });
  });

  it('drops undefined / non-finite fields', () => {
    const s = packState({ idx: NaN, voi: { lower: 1, upper: undefined }, zoom: Infinity });
    expect(s).toEqual({});
  });

  it('normalizes rotation into 0..359', () => {
    expect(packState({ rotation: -90 }).rotation).toBe(270);
    expect(packState({ rotation: 450 }).rotation).toBe(90);
  });
});

describe('statesEqual', () => {
  it('true for structurally identical states', () => {
    const a = { idx: 2, voi: { lower: 0, upper: 100 }, invert: false, zoom: 1, pan: [1, 2] };
    const b = { idx: 2, voi: { lower: 0, upper: 100 }, invert: false, zoom: 1, pan: [1, 2] };
    expect(statesEqual(a, b)).toBe(true);
  });
  it('false when any tracked field differs', () => {
    expect(statesEqual({ idx: 1 }, { idx: 2 })).toBe(false);
    expect(statesEqual({ voi: { lower: 0, upper: 1 } }, { voi: { lower: 0, upper: 2 } })).toBe(false);
    expect(statesEqual({ pan: [1, 2] }, { pan: [1, 3] })).toBe(false);
    expect(statesEqual({ invert: true }, { invert: false })).toBe(false);
  });
  it('handles null/absent operands', () => {
    expect(statesEqual(null, { idx: 1 })).toBe(false);
    expect(statesEqual({ idx: 1 }, null)).toBe(false);
  });
});

describe('throttle', () => {
  let clock;
  beforeEach(() => {
    clock = 0;
    throttle._now = () => clock;
    vi.useFakeTimers();
  });
  afterEach(() => {
    throttle._now = undefined;
    vi.useRealTimers();
  });

  it('fires leading immediately, coalesces bursts into one trailing', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');            // leading → fires now
    expect(fn).toHaveBeenCalledTimes(1);
    t('b'); t('c');    // within window → schedule one trailing with latest
    expect(fn).toHaveBeenCalledTimes(1);
    clock = 100;
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('cancel() stops a pending trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a'); t('b');
    t.cancel();
    clock = 200;
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1); // only the leading
  });
});

describe('roomChannelName', () => {
  it('prefixes the study id', () => {
    expect(roomChannelName('abc-123')).toBe('imaging-room:abc-123');
  });
});

describe('cbctRoomId', () => {
  it('namespaces the study id so CBCT never collides with the 2D room', () => {
    expect(cbctRoomId('abc-123')).toBe('abc-123:cbct');
    expect(roomChannelName(cbctRoomId('abc-123'))).toBe('imaging-room:abc-123:cbct');
    expect(roomChannelName(cbctRoomId('abc-123'))).not.toBe(roomChannelName('abc-123'));
  });
});

describe('serializeCbctState', () => {
  it('packs the shared CBCT controls', () => {
    expect(serializeCbctState({ mode: 'mpr-3d', preset: 'Bone', invert: false, slab: 4.26 }))
      .toEqual({ mode: 'mpr-3d', preset: 'Bone', invert: false, slab: 4.3 });
  });

  it('drops empty / non-finite / negative fields', () => {
    expect(serializeCbctState({ mode: '', preset: 'Bone', slab: NaN, invert: 'yes' }))
      .toEqual({ preset: 'Bone' });
    expect(serializeCbctState({ slab: -5 })).toBeNull();
    expect(serializeCbctState()).toBeNull();
  });

  it('CBCT frames dedupe via statesEqual (mode/preset/slab tracked)', () => {
    const a = { mode: 'mpr-3d', preset: 'Bone', invert: false, slab: 0 };
    expect(statesEqual(a, { ...a })).toBe(true);
    expect(statesEqual(a, { ...a, mode: 'ceph' })).toBe(false);
    expect(statesEqual(a, { ...a, preset: 'Soft Tissue' })).toBe(false);
    expect(statesEqual(a, { ...a, slab: 5 })).toBe(false);
  });
});

describe('applyCbctState', () => {
  const setters = () => ({
    setViewMode: vi.fn(),
    applyPresetByName: vi.fn(),
    setInvert: vi.fn(),
    setSlab: vi.fn(),
  });

  it('calls only the setters for fields that changed', () => {
    const s = setters();
    const current = { mode: 'mpr-3d', preset: 'Bone', invert: false, slab: 0 };
    applyCbctState(current, { mode: 'mpr-3d', preset: 'Soft Tissue', invert: false, slab: 6 }, s);
    expect(s.setViewMode).not.toHaveBeenCalled();
    expect(s.applyPresetByName).toHaveBeenCalledOnce();
    expect(s.applyPresetByName).toHaveBeenCalledWith('Soft Tissue');
    expect(s.setInvert).not.toHaveBeenCalled();
    expect(s.setSlab).toHaveBeenCalledOnce();
    expect(s.setSlab).toHaveBeenCalledWith(6);
  });

  it('is a no-op for an identical frame (echo-safe)', () => {
    const s = setters();
    const frame = { mode: 'ceph', preset: 'Bone', invert: true, slab: 3 };
    applyCbctState({ ...frame }, { ...frame }, s);
    for (const fn of Object.values(s)) expect(fn).not.toHaveBeenCalled();
  });

  it('applies everything when there is no current state yet', () => {
    const s = setters();
    applyCbctState(null, { mode: 'pano', preset: 'Air', invert: true, slab: 2 }, s);
    expect(s.setViewMode).toHaveBeenCalledWith('pano');
    expect(s.applyPresetByName).toHaveBeenCalledWith('Air');
    expect(s.setInvert).toHaveBeenCalledWith(true);
    expect(s.setSlab).toHaveBeenCalledWith(2);
  });

  it('tolerates null frames and missing setters', () => {
    expect(() => applyCbctState({ mode: 'mpr-3d' }, null, setters())).not.toThrow();
    expect(() => applyCbctState(null, { mode: 'ceph', slab: 1 }, {})).not.toThrow();
  });
});

// A fake Cornerstone stack viewport that records what the follower applied.
function fakeViewport(initial = {}) {
  const state = {
    idx: initial.idx ?? 0,
    props: initial.props ?? {},
    pres: initial.pres ?? {},
    rendered: 0,
  };
  return {
    _state: state,
    getCurrentImageIdIndex: () => state.idx,
    getProperties: () => state.props,
    getViewPresentation: () => state.pres,
    setImageIdIndex: (i) => { state.idx = i; },
    setProperties: (p) => { state.props = { ...state.props, ...p }; },
    setViewPresentation: (p) => { state.pres = { ...state.pres, ...p }; },
    render: () => { state.rendered += 1; },
  };
}

describe('serialize2DState ↔ apply2DState round trip', () => {
  it('reconstructs the operator view on the follower', () => {
    const operator = fakeViewport({
      idx: 5,
      props: { voiRange: { lower: 20, upper: 380 }, invert: true },
      pres: { rotation: 90, flipHorizontal: true, flipVertical: false, zoom: 2.5, pan: [10, -4] },
    });
    const frame = serialize2DState(operator);
    expect(frame.idx).toBe(5);
    expect(frame.voi).toEqual({ lower: 20, upper: 380 });

    const follower = fakeViewport();
    apply2DState(follower, frame);

    expect(follower._state.idx).toBe(5);
    expect(follower._state.props.voiRange).toEqual({ lower: 20, upper: 380 });
    expect(follower._state.props.invert).toBe(true);
    expect(follower._state.pres).toMatchObject({
      rotation: 90, flipHorizontal: true, flipVertical: false, zoom: 2.5, pan: [10, -4],
    });
    expect(follower._state.rendered).toBe(1);
  });

  it('serialize returns null for a missing viewport; apply is a no-op', () => {
    expect(serialize2DState(null)).toBeNull();
    expect(() => apply2DState(null, { idx: 1 })).not.toThrow();
    const vp = fakeViewport();
    apply2DState(vp, null);
    expect(vp._state.rendered).toBe(0);
  });

  it('applies rotation 0 + no zoom/pan when the frame omits them', () => {
    const follower = fakeViewport();
    apply2DState(follower, { idx: 1 });
    expect(follower._state.pres).toEqual({ rotation: 0, flipHorizontal: false, flipVertical: false });
  });
});
