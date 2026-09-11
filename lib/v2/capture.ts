export type Fix = {
  lat: number;
  lng: number;
  accuracy: number;
  located_at: string;
  heading: number | null;
  speed: number | null;
  altitude: number | null;
};
export function metres(
  a: Pick<Fix, 'lat' | 'lng'>,
  b: Pick<Fix, 'lat' | 'lng'>,
) {
  const rad = Math.PI / 180,
    dlat = (b.lat - a.lat) * rad,
    dlng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlng / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function spacing(
  anchor: Fix | null,
  current: Fix | null,
  interval: number,
) {
  if (!current) return { distance: 0, ready: false };
  if (!anchor) return { distance: 0, ready: true };
  const distance = metres(anchor, current);
  // GPS error discs overlap: do not turn stationary jitter into walked distance.
  return {
    distance,
    ready:
      Math.max(0, distance - anchor.accuracy - current.accuracy) >= interval,
  };
}
export function freshFix(fix: Fix | null, now = Date.now()) {
  return (
    !!fix &&
    now - Date.parse(fix.located_at) <= 15000 &&
    now >= Date.parse(fix.located_at)
  );
}
