// How the mini map is looking: what it is centred on and how far it reaches. Pure (imports nothing, storage only inside try),
// tested by test/mapView.test.mjs; minimap.js draws from it. `radius` is metres from the centre to the rim, null for automatic.
//
// The zoom ring runs round the rim, open at the bottom where the scale is written: its angle is degrees clockwise from the
// top, RING_SPAN either way. Round to the right is closer in, and equal angles are equal ratios of distance.

export const MAP_VIEW_KEY = 'intercept.map.view';
export const MAP_NEAR = 150; // m to the rim, the closest it goes
export const MAP_FAR = 25000; // room for a 15 km turn back seen from either end
export const RING_SPAN = 140;

const clampRadius = (r) => Math.min(MAP_FAR, Math.max(MAP_NEAR, r));

export function validateMapView(o) {
  const center = o?.center === 'drone' ? 'drone' : 'ship';
  const r = Number(o?.radius);
  // `rings`: the range rings and the cross are drawn only when asked for (they hide the track), so it is kept only when on.
  return { center, radius: o?.radius != null && Number.isFinite(r) && r > 0 ? clampRadius(r) : null, ...(o?.rings === true ? { rings: true } : null) };
}
export function loadMapView() {
  try {
    const raw = globalThis.localStorage?.getItem(MAP_VIEW_KEY);
    return validateMapView(raw ? JSON.parse(raw) : null);
  } catch {
    return validateMapView(null);
  }
}
export function saveMapView(view) {
  try { globalThis.localStorage?.setItem(MAP_VIEW_KEY, JSON.stringify(view)); } catch { /* storage unavailable */ }
}

// The ring's angle for a radius, and back.
export function ringAngle(radius) {
  const u = Math.log(clampRadius(radius) / MAP_FAR) / Math.log(MAP_NEAR / MAP_FAR);
  return -RING_SPAN + u * 2 * RING_SPAN;
}
export function radiusAtAngle(deg) {
  const u = (Math.min(RING_SPAN, Math.max(-RING_SPAN, deg)) + RING_SPAN) / (2 * RING_SPAN);
  return MAP_FAR * (MAP_NEAR / MAP_FAR) ** u;
}
// The angle of a pointer at (dx, dy) from the disc's centre, screen coordinates (y down). The closed gap at the bottom goes
// to the nearer end of the ring.
export function pointerAngle(dx, dy) {
  return Math.min(RING_SPAN, Math.max(-RING_SPAN, (Math.atan2(dx, -dy) * 180) / Math.PI));
}
// One notch of the mouse wheel: rolling toward you (deltaY > 0) reaches further out.
export function wheelRadius(radius, deltaY) {
  return clampRadius(radius * (deltaY > 0 ? 1.2 : 1 / 1.2));
}

// The automatic zoom's steps, metres to the rim.
export const AUTO_STEPS = [300, 500, 750, 1000, 1500, 2000, 3000, 4500, 7000, 10000, 15000, 25000];
export function autoRadius(reach) {
  const want = Math.max(reach * 1.15, 250);
  return AUTO_STEPS.find((r) => r >= want) ?? AUTO_STEPS[AUTO_STEPS.length - 1];
}
export const ringStep = (R) => (R >= 10000 ? 5000 : R >= 4000 ? 2000 : R >= 2000 ? 500 : R >= 1000 ? 250 : R >= 500 ? 100 : 50);

export function radiusLabel(R) {
  if (R < 1000) return `${Math.round(R)} m`;
  return `${R < 10000 ? Math.round(R / 100) / 10 : Math.round(R / 1000)} km`;
}
