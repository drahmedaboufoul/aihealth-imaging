/*
 * viewerRoom — pure helpers for live co-viewing sync (the DentalX room
 * pattern). Framework-free so the state serialization + change detection +
 * throttle are unit-testable without Supabase or Cornerstone.
 *
 * The operator's viewer serializes its navigation state (slice, window/level,
 * invert, rotation/flip, zoom, pan) and broadcasts it on a Supabase Realtime
 * channel keyed by the study id; followers apply it. Only ephemeral view
 * state travels over the wire — never pixels or PHI (the follower already has
 * its own signed URLs from a valid share link).
 */

const round = (n, dp = 3) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Normalize a raw view-state bag into a compact, comparison-stable payload.
 * Undefined / non-finite fields are dropped so equality is meaningful and the
 * wire payload stays small.
 */
export function packState(raw = {}) {
  const out = {};
  if (Number.isFinite(raw.idx)) out.idx = Math.round(raw.idx);
  if (raw.voi && Number.isFinite(raw.voi.lower) && Number.isFinite(raw.voi.upper)) {
    out.voi = { lower: Math.round(raw.voi.lower), upper: Math.round(raw.voi.upper) };
  }
  if (typeof raw.invert === 'boolean') out.invert = raw.invert;
  if (Number.isFinite(raw.rotation)) out.rotation = ((Math.round(raw.rotation) % 360) + 360) % 360;
  if (typeof raw.flipH === 'boolean') out.flipH = raw.flipH;
  if (typeof raw.flipV === 'boolean') out.flipV = raw.flipV;
  const zoom = round(raw.zoom, 4);
  if (zoom !== undefined) out.zoom = zoom;
  if (Array.isArray(raw.pan) && raw.pan.length === 2) {
    const px = round(raw.pan[0], 2);
    const py = round(raw.pan[1], 2);
    if (px !== undefined && py !== undefined) out.pan = [px, py];
  }
  return out;
}

/** Structural equality for two packed states (so we don't echo no-op frames). */
export function statesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = ['idx', 'invert', 'rotation', 'flipH', 'flipV', 'zoom'];
  for (const k of keys) if (a[k] !== b[k]) return false;
  const voiEq = (!a.voi && !b.voi) || (a.voi && b.voi && a.voi.lower === b.voi.lower && a.voi.upper === b.voi.upper);
  if (!voiEq) return false;
  const panEq = (!a.pan && !b.pan) || (a.pan && b.pan && a.pan[0] === b.pan[0] && a.pan[1] === b.pan[1]);
  if (!panEq) return false;
  return true;
}

/**
 * Leading + trailing throttle. Calls fn at most once per `ms`; a call during
 * the cooldown schedules one trailing invocation with the latest args.
 * Returns the wrapped fn with a .cancel().
 */
export function throttle(fn, ms) {
  let last = -Infinity; // so the very first call always fires immediately
  let timer = null;
  let lastArgs = null;
  // Injectable clock so tests don't depend on Date.now (which is also blocked
  // in some sandboxes); defaults to a monotonic-ish now.
  const nowFn = throttle._now || (() => Date.now());
  const wrapped = (...args) => {
    const now = nowFn();
    lastArgs = args;
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      last = now;
      if (timer) { clearTimeout(timer); timer = null; }
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = nowFn();
        timer = null;
        fn(...lastArgs);
      }, remaining);
    }
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

export const ROOM_PREFIX = 'imaging-room:';
export function roomChannelName(studyId) {
  return `${ROOM_PREFIX}${studyId}`;
}

/**
 * Serialize a Cornerstone 2D stack viewport's navigation state into a packed
 * frame. `vp` is any object exposing the subset of the Cornerstone3D
 * StackViewport API we read — so this is testable with a plain fake.
 */
export function serialize2DState(vp) {
  if (!vp) return null;
  const props = (vp.getProperties && vp.getProperties()) || {};
  let pres = {};
  try { pres = (vp.getViewPresentation && vp.getViewPresentation()) || {}; } catch { /* older api */ }
  return packState({
    idx: vp.getCurrentImageIdIndex ? vp.getCurrentImageIdIndex() : 0,
    voi: props.voiRange ? { lower: props.voiRange.lower, upper: props.voiRange.upper } : undefined,
    invert: typeof props.invert === 'boolean' ? props.invert : undefined,
    rotation: pres.rotation,
    flipH: pres.flipHorizontal,
    flipV: pres.flipVertical,
    zoom: pres.zoom,
    pan: pres.pan,
  });
}

/** Apply a packed frame to a 2D stack viewport (the follower side). */
export function apply2DState(vp, s) {
  if (!vp || !s) return;
  if (typeof s.idx === 'number' && vp.setImageIdIndex) vp.setImageIdIndex(s.idx);
  const setProps = {};
  if (s.voi) setProps.voiRange = { lower: s.voi.lower, upper: s.voi.upper };
  if (typeof s.invert === 'boolean') setProps.invert = s.invert;
  if (Object.keys(setProps).length && vp.setProperties) vp.setProperties(setProps);
  if (vp.setViewPresentation) {
    vp.setViewPresentation({
      rotation: s.rotation || 0,
      flipHorizontal: !!s.flipH,
      flipVertical: !!s.flipV,
      ...(s.zoom !== undefined ? { zoom: s.zoom } : {}),
      ...(s.pan !== undefined ? { pan: s.pan } : {}),
    });
  }
  if (vp.render) vp.render();
}
