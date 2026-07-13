import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  packState,
  statesEqual,
  throttle,
  roomChannelName,
  serialize2DState,
  apply2DState,
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
