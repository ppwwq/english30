// Positions are thousandths of the page width/height. Pressure is 0–100.
export const inkColors = ['#24241f', '#254c8b', '#a53540', '#25714d', '#f3d44f', '#ad95ef'];
export function isPaperStroke(s) {
  if (typeof s === 'string') return /^(?:\d{1,4},\d{1,4})(?: \d{1,4},\d{1,4})*$/.test(s);
  return (
    s &&
    ['pen', 'pencil', 'marker', 'line'].includes(s.tool) &&
    inkColors.includes(s.color) &&
    Number.isFinite(s.width) &&
    s.width >= 0.5 &&
    s.width <= 64 &&
    Array.isArray(s.points) &&
    s.points.length > 0 &&
    s.points.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 3 &&
        p.every(Number.isFinite) &&
        p[0] >= 0 &&
        p[0] <= 1000 &&
        p[1] >= 0 &&
        p[1] <= 1000 &&
        p[2] >= 0 &&
        p[2] <= 100,
    )
  );
}
export function readStroke(value) {
  if (typeof value !== 'string') return value;
  return {
    tool: 'line',
    color: inkColors[0],
    width: 2.5,
    points: value.split(' ').map((pair) => [...pair.split(',').map((v) => Math.min(1000, Number(v))), 50]),
  };
}
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
const mix = (p, q, t) => p.map((v, i) => Math.round((v + (q[i] - v) * t) * 100) / 100);

// Clip a stroke segment against the two round caps and rectangle swept by the eraser.
function cutInterval(p, q, a, b, radius, aspect) {
  const dx = q[0] - p[0],
    dy = (q[1] - p[1]) * aspect;
  const ex = b[0] - a[0],
    ey = (b[1] - a[1]) * aspect;
  const x = p[0] - a[0],
    y = (p[1] - a[1]) * aspect;
  const intervals = [];
  function cap(x, y) {
    const A = dx * dx + dy * dy,
      C = x * x + y * y - radius * radius;
    if (!A) {
      if (C <= 0) intervals.push([0, 1]);
      return;
    }
    const B = x * dx + y * dy,
      det = B * B - A * C;
    if (det >= 0) intervals.push([(-B - Math.sqrt(det)) / A, (-B + Math.sqrt(det)) / A]);
  }
  cap(x, y);
  const length = Math.hypot(ex, ey);
  if (length) {
    cap(x - ex, y - ey);
    let lo = 0,
      hi = 1;
    function band(start, step, min, max) {
      if (!step) {
        if (start < min || start > max) hi = -1;
        return;
      }
      const u = (min - start) / step,
        v = (max - start) / step;
      lo = Math.max(lo, Math.min(u, v));
      hi = Math.min(hi, Math.max(u, v));
    }
    band(x * ex + y * ey, dx * ex + dy * ey, 0, length * length);
    band(x * ey - y * ex, dx * ey - dy * ex, -radius * length, radius * length);
    intervals.push([lo, hi]);
  }
  const hits = intervals.map(([lo, hi]) => [Math.max(0, lo), Math.min(1, hi)]).filter(([lo, hi]) => lo <= hi);
  return hits.length ? [Math.min(...hits.map((h) => h[0])), Math.max(...hits.map((h) => h[1]))] : null;
}
export function eraseStroke(value, a, b, radius, aspect, whole) {
  const s = readStroke(value),
    pts = s.points,
    parts = [];
  const reach = radius + s.width / 2;
  let box = strokeBounds.get(s);
  if (!box) {
    box = selectionBounds([s]);
    strokeBounds.set(s, box);
  }
  if (
    Math.max(a[0], b[0]) < box.left - reach ||
    Math.min(a[0], b[0]) > box.right + reach ||
    Math.max(a[1], b[1]) < box.top - reach / aspect ||
    Math.min(a[1], b[1]) > box.bottom + reach / aspect
  )
    return [value];
  let current = [],
    hit = false;
  function keep(p) {
    const last = current.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) current.push(p);
  }
  function finish() {
    if (current.length) parts.push({ ...s, points: current });
    current = [];
  }
  for (let i = 0; i < Math.max(pts.length - 1, 1); i++) {
    const p = pts[i],
      q = pts[i + 1] || p;
    const cut = cutInterval(p, q, a, b, reach, aspect);
    if (!cut) {
      keep(p);
      keep(q);
      continue;
    }
    if (whole) return [];
    hit = true;
    if (cut[0] > 0) {
      keep(p);
      keep(mix(p, q, cut[0]));
    }
    finish();
    if (cut[1] < 1) {
      keep(mix(p, q, cut[1]));
      keep(q);
    }
  }
  if (!hit) return [value];
  finish();
  return parts;
}
export function insideLasso(p, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
const strokeBounds = new WeakMap();
export function selectionBounds(items) {
  const box = { left: 1000, right: 0, top: 1000, bottom: 0 };
  for (const item of items)
    for (const [x, y] of readStroke(item).points) {
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
  return box;
}
export function moveSelection(items, dx, dy) {
  const box = selectionBounds(items);
  dx = clamp(dx, -box.left, 1000 - box.right);
  dy = clamp(dy, -box.top, 1000 - box.bottom);
  return items.map((value) => {
    const s = readStroke(value);
    const offset = (n, delta) => clamp(Math.round((n + delta) * 100) / 100, 0, 1000);
    return { ...s, points: s.points.map(([x, y, p]) => [offset(x, dx), offset(y, dy), p]) };
  });
}
