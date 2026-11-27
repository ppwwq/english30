import { getStroke } from './vendor/perfect-freehand/index.mjs';
import {
  eraseStroke,
  inkColors,
  insideLasso,
  moveSelection,
  readStroke,
  selectionBounds,
} from './paper-ink-geometry.mjs';
import { mountInkTools } from './paper-ink-tools.mjs';

const NS = 'http://www.w3.org/2000/svg';
const answerSettings = {
  mode: 'pen',
  finger: 'pan',
  eraseMode: 'partial',
  eraseSizes: [6, 12, 22],
  eraseSlot: 1,
  brushes: {
    pen: { size: 2, color: inkColors[0] },
    pencil: { size: 2, color: inkColors[0] },
    marker: { size: 2, color: inkColors[4], widths: [10, 17, 25] },
    line: { size: 2, color: inkColors[0] },
  },
};
const reviewSettings = structuredClone(answerSettings);
reviewSettings.brushes.pen.color = inkColors[2];
function element(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
export function renderStroke(value, aspect) {
  const s = readStroke(value);
  let node;
  if (typeof value === 'string') {
    node = element('polyline', {
      points: s.points.map(([x, y]) => x + ',' + y * aspect).join(' '),
      'vector-effect': 'non-scaling-stroke',
    });
  } else {
    const points = s.points.map(([x, y, p]) => [x, y * aspect, p / 100]);
    const outline = getStroke(points, {
      size: s.width,
      simulatePressure: false,
      thinning: s.tool === 'pencil' ? 0.85 : s.tool === 'pen' ? 0.65 : 0,
      streamline: s.tool === 'pen' ? 0.25 : 0,
      smoothing: 0.5,
      last: true,
    });
    const d = outline.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2)).join('') + 'Z';
    node = element('path', {
      d,
      fill: s.color,
      opacity: s.tool === 'marker' ? 0.38 : s.tool === 'pencil' ? 0.72 : 1,
    });
  }
  node.classList.add('ink-stroke');
  return node;
}
export function mountPaperInk(stage, tools, writing, reviewing = false, idPrefix = '') {
  const settings = reviewing ? reviewSettings : answerSettings;
  let pages = writing.ink || {};
  const svg = element('svg', {
    preserveAspectRatio: 'none',
    'aria-label': reviewing ? '原卷批注' : '原卷手写笔迹',
    tabindex: '0',
  });
  svg.classList.add('paper-ink');
  stage.append(svg);
  const submitted = element('g', { class: 'submitted-ink', 'pointer-events': 'none' });
  if (reviewing) svg.append(submitted);
  const layer = element('g'),
    overlay = element('g', { 'pointer-events': 'none' });
  svg.append(layer, overlay);
  const wrap = stage.parentElement;
  stage.querySelector('img').draggable = false;
  for (const type of ['selectstart', 'contextmenu']) {
    wrap.addEventListener(type, (e) => e.preventDefault());
  }
  wrap.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') e.preventDefault();
  });
  let pageKey = null,
    aspect = 1,
    gesture = null,
    selected = [],
    paintFrame = 0;
  const histories = new Map();
  const rendered = new WeakMap();
  const entries = () => pages[pageKey] || [];
  const history = () => histories.get(pageKey);
  function paint(values = entries()) {
    const nodes = values.map((s) => {
      if (typeof s === 'string') return renderStroke(s, aspect);
      const cached = rendered.get(s);
      if (cached?.aspect === aspect) return cached.node;
      const node = renderStroke(s, aspect);
      rendered.set(s, { aspect, node });
      return node;
    });
    layer.replaceChildren(...nodes);
    showSelection();
  }
  function showSelection() {
    overlay.replaceChildren();
    if (!selected.length) return;
    const b = selectionBounds(selected);
    overlay.append(
      element('rect', {
        x: b.left - 3,
        y: b.top * aspect - 3,
        width: b.right - b.left + 6,
        height: (b.bottom - b.top) * aspect + 6,
        class: 'ink-selection',
      }),
    );
  }
  function sync() {
    tools.hidden = !pageKey;
    svg.classList.toggle('can-pan', settings.mode === 'pan');
    controls?.refresh({
      pageKey,
      hasInk: entries().length > 0,
      canUndo: !!history()?.before.length || !!entries().length,
      canRedo: !!history()?.after.length,
      selected: selected.length > 0,
    });
  }
  function replace(values) {
    if (reviewing) pages = { ...pages };
    if (values.length) pages[pageKey] = values;
    else delete pages[pageKey];
    writing.changed(pageKey, pages);
    paint();
    sync();
  }
  function commit(values) {
    const h = history();
    h.before.push(entries());
    if (h.before.length > 60) h.before.shift();
    h.after = [];
    replace(values);
  }
  function undo() {
    cancel();
    const h = history();
    if (!h || (!h.before.length && !entries().length)) return;
    h.after.push(entries());
    selected = [];
    replace(h.before.pop() ?? entries().slice(0, -1));
  }
  function redo() {
    cancel();
    const h = history();
    if (!h?.after.length) return;
    h.before.push(entries());
    selected = [];
    replace(h.after.pop());
  }
  const controls = mountInkTools(
    tools,
    settings,
    {
      mode: (key) => {
        cancel();
        settings.mode = key;
        selected = [];
        showSelection();
        sync();
      },
      undo,
      redo,
      clear: () => {
        selected = [];
        commit([]);
      },
      remove: () => {
        const keep = entries().filter((s) => !selected.includes(s));
        selected = [];
        commit(keep);
      },
      copy: () => {
        selected = moveSelection(selected, 12, 12);
        commit([...entries(), ...selected]);
      },
    },
    reviewing,
    idPrefix,
  );
  function show(key) {
    cancel();
    pageKey = key;
    selected = [];
    const img = stage.querySelector('img');
    aspect = Number(img.getAttribute('height')) / Number(img.getAttribute('width')) || 1;
    svg.setAttribute('viewBox', '0 0 1000 ' + 1000 * aspect);
    svg.style.display = key ? '' : 'none';
    if (reviewing)
      submitted.replaceChildren(...(writing.submittedInk?.[key] || []).map((s) => renderStroke(s, aspect)));
    if (key && !histories.has(key)) histories.set(key, { before: [], after: [] });
    paint();
    sync();
  }
  function cancel() {
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    if (gesture) {
      gesture = null;
      paint();
    }
  }
  function point(e) {
    const box = gesture.box;
    const unit = (p, origin, len) =>
      Math.round(Math.max(0, Math.min(1000, ((p - origin) * 1000) / len)) * 10) / 10;
    let pressure =
      e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) : (gesture.last?.[2] ?? 50);
    if (gesture.kind === 'pencil' && e.pointerType === 'pen' && e.pressure > 0) {
      const tilt = Math.min(1, Math.hypot(e.tiltX || 0, e.tiltY || 0) / 80);
      pressure = Math.round(Math.min(100, pressure * 0.7 + tilt * 46));
    }
    return [unit(e.clientX, box.left, box.width), unit(e.clientY, box.top, box.height), pressure];
  }
  function erase(a, b) {
    const g = gesture;
    const radius = (settings.eraseSizes[settings.eraseSlot] * 1000) / g.box.width;
    const next = g.values.flatMap((s) =>
      eraseStroke(s, a, b, radius, aspect, settings.eraseMode === 'whole'),
    );
    if (next.length !== g.values.length || next.some((s, i) => s !== g.values[i])) {
      g.values = next;
      g.edited = true;
      g.dirty = true;
    }
  }
  function sample(e) {
    const g = gesture,
      p = point(e),
      last = g.last;
    if (last && p.every((v, i) => v === last[i])) return;
    g.last = p;
    if (g.kind === 'erase') {
      erase(last || p, p);
      return;
    }
    if (g.kind === 'move') {
      g.dx = p[0] - g.start[0];
      g.dy = p[1] - g.start[1];
      return;
    }
    if (g.kind === 'line' && g.points.length > 1) g.points[1] = p;
    else g.points.push(p);
  }
  function movedValues(g) {
    const moved = moveSelection(selected, g.dx, g.dy);
    const byOriginal = new Map(selected.map((s, i) => [s, moved[i]]));
    return { values: entries().map((s) => byOriginal.get(s) || s), moved };
  }
  function preview() {
    paintFrame = 0;
    const g = gesture;
    if (!g || !g.last) return;
    if (g.kind === 'erase') {
      if (g.dirty) {
        paint(g.values);
        g.dirty = false;
      }
      overlay.replaceChildren(
        element('circle', {
          cx: g.last[0],
          cy: g.last[1] * aspect,
          r: (settings.eraseSizes[settings.eraseSlot] * 1000) / g.box.width,
          class: 'ink-eraser-tip',
        }),
      );
    } else if (g.kind === 'lasso') {
      overlay.replaceChildren(
        element('polygon', {
          points: g.points.map(([x, y]) => x + ',' + y * aspect).join(' '),
          class: 'ink-selection',
        }),
      );
    } else if (g.kind === 'move') {
      const { values } = movedValues(g);
      paint(values);
      overlay.replaceChildren();
    } else {
      overlay.replaceChildren(renderStroke(g.stroke, aspect));
    }
  }
  function schedule() {
    if (!paintFrame) paintFrame = requestAnimationFrame(preview);
  }
  let finger = null;
  svg.onpointerdown = (e) => {
    if (!pageKey || settings.mode === 'pan' || e.button !== 0) return;
    e.preventDefault();
    if (e.pointerType === 'touch' && settings.finger === 'pan') {
      if (!gesture && !finger) {
        finger = { id: e.pointerId, x: e.clientX, y: e.clientY, left: wrap.scrollLeft };
        capture(e);
      }
      return;
    }
    if (gesture) return;
    finger = null;
    const box = svg.getBoundingClientRect();
    if (!box.width || !box.height) return;
    capture(e);
    tools.dispatchEvent(new Event('ink-dismiss'));
    if (e.pointerType !== 'touch') svg.focus({ preventScroll: true });
    const g = (gesture = {
      id: e.pointerId,
      kind: settings.mode,
      points: [],
      box,
      values: entries(),
      dx: 0,
      dy: 0,
    });
    g.start = point(e);
    if (g.kind === 'lasso' && selected.length) {
      const b = selectionBounds(selected),
        [x, y] = g.start;
      if (x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 8 && y <= b.bottom + 8) g.kind = 'move';
      else {
        selected = [];
        showSelection();
        sync();
      }
    }
    const brush = settings.brushes[g.kind];
    if (brush)
      g.stroke = {
        tool: g.kind,
        color: brush.color,
        width: (brush.widths || [1.8, 3.2, 5.5])[brush.size - 1],
        points: g.points,
      };
    sample(e);
    schedule();
  };
  function capture(e) {
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* Synthetic input or lost contact. */
    }
  }
  svg.onpointermove = (e) => {
    if (finger?.id === e.pointerId) {
      const top = wrap.scrollTop;
      const dy = finger.y - e.clientY;
      wrap.scrollTo(finger.left + finger.x - e.clientX, top + dy);
      if (reviewing) window.scrollBy(0, dy - (wrap.scrollTop - top));
      finger.y = e.clientY;
      return;
    }
    if (gesture?.id !== e.pointerId) return;
    for (const s of e.getCoalescedEvents?.() || []) sample(s);
    sample(e);
    schedule();
  };
  svg.onpointerup = (e) => {
    if (finger?.id === e.pointerId) {
      finger = null;
      return;
    }
    const g = gesture;
    if (g?.id !== e.pointerId) return;
    sample(e);
    cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    gesture = null;
    if (g.kind === 'lasso') {
      selected = entries().filter((s) => readStroke(s).points.some((p) => insideLasso(p, g.points)));
      showSelection();
      sync();
    } else if (g.kind === 'move' && (g.dx || g.dy)) {
      const { values, moved } = movedValues(g);
      selected = moved;
      commit(values);
    } else if (g.kind === 'erase' && g.edited) commit(g.values);
    else if (g.stroke) commit([...entries(), g.stroke]);
    else {
      paint();
      sync();
    }
  };
  svg.onlostpointercapture = svg.onpointercancel = (e) => {
    if (finger?.id === e.pointerId) finger = null;
    if (gesture?.id === e.pointerId) cancel();
  };
  svg.addEventListener('ink-cancel-touch', () => {
    finger = null;
    cancel();
  });
  function keydown(e) {
    if (!pageKey || e.target.closest('select,input')) return;
    if ((e.metaKey || e.ctrlKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
      else undo();
    } else if (e.key === 'Escape') {
      cancel();
      selected = [];
      showSelection();
      sync();
    } else if (selected.length && ['Backspace', 'Delete'].includes(e.key)) {
      e.preventDefault();
      const keep = entries().filter((s) => !selected.includes(s));
      selected = [];
      commit(keep);
    }
  }
  svg.addEventListener('keydown', keydown);
  tools.addEventListener('keydown', keydown);
  return {
    show,
    destroy() {
      cancel();
      controls.destroy();
    },
  };
}
