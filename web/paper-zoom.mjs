import { inkIcon } from './ink-icons.mjs';
let lastPaperZoom;

// Scale the scan and the ink as one page, preserving the paper point beneath the gesture.
export function mountPaperZoom(wrap, stage, trigger, panelId = 'paper-zoom-panel') {
  const control = document.createElement('div');
  control.className = 'paper-zoom-control';
  const panel = document.createElement('div');
  panel.className = 'paper-zoom-panel';
  panel.hidden = true;
  panel.id = panelId;
  trigger.setAttribute('aria-controls', panel.id);
  trigger.removeAttribute('aria-pressed');
  inkIcon(trigger, 'zoom', '调整纸面缩放');
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 35;
  slider.max = 300;
  slider.step = 1;
  slider.setAttribute('aria-label', '纸面缩放比例');
  const output = document.createElement('output');
  const fit = document.createElement('button');
  fit.type = 'button';
  inkIcon(fit, 'fit', '恢复适合宽度');
  panel.append(slider, output, fit);
  control.append(trigger, panel);
  wrap.classList.add('paper-zoomable');
  let percent =
    lastPaperZoom ?? (matchMedia('(min-width: 1000px) and (orientation: landscape)').matches ? 80 : 100);
  function toggle(open) {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }
  function pointOnPage(x, y) {
    const r = stage.getBoundingClientRect();
    return [(x - r.left) / r.width, (y - r.top) / r.height];
  }
  function set(value, x, y, anchor) {
    const r = wrap.getBoundingClientRect();
    x ??= r.left + wrap.clientWidth / 2;
    y ??= r.top + wrap.clientHeight / 2;
    anchor ??= pointOnPage(x, y);
    percent = Math.min(300, Math.max(35, Math.round(value)));
    lastPaperZoom = percent;
    stage.style.width = percent + '%';
    slider.value = String(percent);
    output.value = percent + '%';
    slider.setAttribute('aria-valuetext', output.value);
    const page = stage.getBoundingClientRect();
    if (anchor.every(Number.isFinite))
      wrap.scrollBy(page.left + anchor[0] * page.width - x, page.top + anchor[1] * page.height - y);
  }
  stage.style.width = percent + '%';
  slider.value = String(percent);
  output.value = percent + '%';
  slider.setAttribute('aria-valuetext', output.value);
  toggle(false);
  trigger.onclick = () => toggle(panel.hidden);
  slider.oninput = () => set(Number(slider.value));
  fit.onclick = () => set(100);
  control.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !control.contains(e.relatedTarget)) toggle(false);
  });
  control.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      e.stopPropagation();
      toggle(false);
      trigger.focus();
    }
  });
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (pen !== null) return;
      set(percent * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.008), e.clientX, e.clientY);
    },
    { passive: false },
  );
  const fingers = new Map();
  let pinch = null,
    consume = false,
    pan = null,
    pen = null;
  function pair() {
    const [a, b] = fingers.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  function take(id) {
    try {
      wrap.setPointerCapture(id);
    } catch {
      /* Contact may already have ended. */
    }
  }
  function block(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      toggle(false);
      if (e.pointerType === 'pen') {
        if (pinch || consume) {
          block(e);
          return;
        }
        pen = e.pointerId;
        if (fingers.size) {
          pan = null;
          consume = true;
        }
        return;
      }
      if (e.pointerType !== 'touch') return;
      if (pen !== null) {
        block(e);
        return;
      }
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2) {
        const a = pair();
        pinch = { distance: a.d, percent, anchor: pointOnPage(a.x, a.y) };
        consume = true;
        pan = null;
        stage.querySelector('.paper-ink')?.dispatchEvent(new Event('ink-cancel-touch'));
        for (const id of fingers.keys()) take(id);
      } else if (fingers.size === 1 && !consume && !e.target.closest('.paper-ink')) {
        pan = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
        take(e.pointerId);
      }
      if (consume || pan) block(e);
    },
    true,
  );
  wrap.addEventListener(
    'pointermove',
    (e) => {
      if (!fingers.has(e.pointerId)) return;
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && fingers.size === 2) {
        const p = pair();
        set((pinch.percent * p.d) / pinch.distance, p.x, p.y, pinch.anchor);
      } else if (pan) wrap.scrollTo(pan.left + pan.x - e.clientX, pan.top + pan.y - e.clientY);
      if (consume || pan) block(e);
    },
    true,
  );
  function end(e) {
    if (e.pointerId === pen) {
      pen = null;
      return;
    }
    if (!fingers.delete(e.pointerId)) return;
    if (consume || pan) block(e);
    if (fingers.size < 2) pinch = null;
    if (!fingers.size) {
      consume = false;
      pan = null;
    }
  }
  for (const name of ['pointerup', 'pointercancel']) wrap.addEventListener(name, end, true);
  wrap.addEventListener(
    'lostpointercapture',
    (e) => {
      if (e.pointerId === pen) pen = null;
    },
    true,
  );
  return control;
}
