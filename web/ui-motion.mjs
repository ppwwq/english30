/* RubberSegment interaction port for English30.
 * React Bits RubberSegment — Copyright (c) 2026 David Haz.
 * MIT + Commons Clause; full notice: ./licenses/rubber-segment.txt
 * Source: the user's saved RubberSegment.tsx/CSS, preset stretch=26, inset=5,
 * radius=28. Vanilla DOM adaptation keeps measured edges, bounded dilation,
 * spring landing/relaxation, drag rubber-banding and gesture cancellation.
 * Business state remains owned by app.mjs via the existing buttons.
 */
const tracks = document.querySelectorAll('.phase-switch');
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const INSET = 5,
  STRETCH = 26,
  RADIUS = 28,
  SLOP = 10,
  DEADZONE = 4,
  RUBBER = 0.55;
for (const track of tracks) {
  const buttons = [...track.querySelectorAll(':scope > button')];
  const thumb = document.createElement('div');
  thumb.className = 'rubber-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  for (const button of buttons) {
    const copy = document.createElement('span');
    copy.className = 'rubber-copy';
    for (const child of button.childNodes) copy.append(child.cloneNode(true));
    thumb.append(copy);
  }
  track.append(thumb);
  track.classList.add('rubber-ready');
  let slots = [],
    innerWidth = 0,
    left = 0,
    right = 0,
    vl = 0,
    vr = 0,
    frame = 0,
    animation = null,
    drag = null,
    suppressClick = false;
  let committed = Math.max(
    0,
    buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true'),
  );
  const active = () =>
    Math.max(
      0,
      buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true'),
    );
  const paint = () => {
    thumb.style.clipPath = `inset(0 ${Math.max(0, innerWidth - right)}px 0 ${Math.max(0, left)}px round ${RADIUS - INSET}px)`;
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    animation = null;
  };
  function jump(index) {
    stop();
    const s = slots[index];
    if (!s) return;
    left = s.l;
    right = s.r;
    vl = vr = 0;
    paint();
  }
  // Invert the x of cubic-bezier(.23,1,.32,1), matching the saved dilation.
  function ease(t) {
    let x = t;
    for (let i = 0; i < 6; i++) {
      const a = 1 - x;
      const fx = 3 * a * a * x * 0.23 + 3 * a * x * x * 0.32 + x * x * x - t;
      const dx = 3 * a * a * 0.23 + 6 * a * x * (0.32 - 0.23) + 3 * x * x * (1 - 0.32);
      if (dx > 0.0001) x = clamp(x - fx / dx, 0, 1);
    }
    return 1 - Math.pow(1 - x, 3);
  }
  function land(to, velocity = null, flick = false, squash = true) {
    const s = slots[to];
    if (!s) return;
    if (reduce.matches) {
      jump(to);
      return;
    }
    stop();
    if (velocity !== null) vl = vr = clamp(velocity, -2000, 2000);
    const dir = Math.sign(s.l + s.r - (left + right)) || 1;
    animation = {
      kind: 'spring',
      to,
      start: performance.now(),
      last: performance.now(),
      flick,
      relax: false,
      l: s.l + (squash && dir > 0 ? 3 : 0),
      r: s.r + (squash && dir < 0 ? -3 : 0),
    };
    frame = requestAnimationFrame(step);
  }
  function travel(from, to) {
    const a = slots[from],
      b = slots[to];
    if (!a || !b) return;
    if (reduce.matches) {
      jump(to);
      return;
    }
    stop();
    const gap = Math.max(Math.abs(a.l - b.l), Math.abs(a.r - b.r));
    const u = Math.min(STRETCH / 100, gap ? ((b.r - b.l) * 0.26) / gap : 0);
    animation = {
      kind: 'dilate',
      fromL: left,
      fromR: right,
      l: b.l + (Math.min(a.l, b.l) - b.l) * u,
      r: b.r + (Math.max(a.r, b.r) - b.r) * u,
      to,
      start: performance.now(),
      last: performance.now(),
    };
    frame = requestAnimationFrame(step);
  }
  function step(now) {
    const a = animation;
    if (!a) return;
    const dt = clamp((now - a.last) / 1000, 0.001, 0.032);
    a.last = now;
    if (a.kind === 'dilate') {
      const t = ease(clamp((now - a.start) / 190, 0, 1)),
        oldL = left,
        oldR = right;
      left = a.fromL + (a.l - a.fromL) * t;
      right = a.fromR + (a.r - a.fromR) * t;
      vl = (left - oldL) / dt;
      vr = (right - oldR) / dt;
      paint();
      if (now - a.start >= 150) {
        land(a.to, null, false, true);
        return;
      }
    } else {
      // Sub-stepped damped springs; restrained UI landing, mild flick momentum.
      const omega = a.relax ? 40 : a.flick ? 27 : 34,
        damping = a.flick && !a.relax ? 1.65 : 2;
      const steps = Math.ceil(dt / 0.006),
        h = dt / steps;
      for (let i = 0; i < steps; i++) {
        vl += (-omega * omega * (left - a.l) - damping * omega * vl) * h;
        vr += (-omega * omega * (right - a.r) - damping * omega * vr) * h;
        left += vl * h;
        right += vr * h;
      }
      paint();
      if (
        (Math.abs(left - a.l) + Math.abs(right - a.r) < 0.08 && Math.abs(vl) + Math.abs(vr) < 1) ||
        now - a.start > 1000
      ) {
        const s = slots[a.to];
        if (!a.relax && (a.l !== s.l || a.r !== s.r)) {
          a.l = s.l;
          a.r = s.r;
          a.relax = true;
          a.start = now;
        } else {
          jump(a.to);
          return;
        }
      }
    }
    frame = requestAnimationFrame(step);
  }
  function release() {
    const previous = drag;
    drag = null;
    if (previous) {
      try {
        buttons[previous.slot].releasePointerCapture(previous.id);
      } catch {
        /* Already released. */
      }
    }
    delete track.dataset.held;
    for (const b of buttons) delete b.dataset.pressed;
  }
  function cancel() {
    if (!drag) return;
    release();
    suppressClick = true;
    jump(active());
  }
  function measure() {
    if (drag) cancel();
    innerWidth = track.clientWidth - INSET * 2;
    slots = buttons.map((b) => ({ l: b.offsetLeft - INSET, r: b.offsetLeft - INSET + b.offsetWidth }));
    committed = active();
    jump(committed);
  }
  function localX(event) {
    const rect = track.getBoundingClientRect();
    return (event.clientX - rect.left) * (track.clientWidth / rect.width) - INSET;
  }
  const rubber = (over, width) => (over * width * RUBBER) / (width + RUBBER * Math.abs(over));
  const nearest = (x) =>
    buttons.reduce(
      (best, b, i) =>
        b.disabled
          ? best
          : best === -1 ||
              Math.abs((slots[i].l + slots[i].r) / 2 - x) < Math.abs((slots[best].l + slots[best].r) / 2 - x)
            ? i
            : best,
      -1,
    );
  buttons.forEach((button, i) => {
    button.addEventListener('pointerdown', (event) => {
      if (button.disabled || event.button !== 0 || event.isPrimary === false || drag) return;
      suppressClick = false;
      const x = localX(event);
      drag = {
        id: event.pointerId,
        slot: i,
        x0: x,
        y0: event.clientY,
        onThumb: x >= left && x <= right,
        live: false,
        hist: [[event.timeStamp, x]],
        offset: 0,
        w: 0,
      };
      if (drag.onThumb) stop();
      else button.dataset.pressed = '';
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        /* Detached controls. */
      }
    });
    button.addEventListener('keydown', (event) => {
      suppressClick = false;
      if (event.key === 'Escape') {
        cancel();
        return;
      }
      const allowed = buttons.map((b, index) => (b.disabled ? -1 : index)).filter((index) => index >= 0);
      let target = null;
      if (['ArrowRight', 'ArrowDown'].includes(event.key))
        target = allowed.find((index) => index > i) ?? allowed.at(-1);
      if (['ArrowLeft', 'ArrowUp'].includes(event.key))
        target = allowed.findLast((index) => index < i) ?? allowed[0];
      if (event.key === 'Home') target = allowed[0];
      if (event.key === 'End') target = allowed.at(-1);
      if (target == null) return;
      event.preventDefault();
      buttons[target].focus({ preventScroll: true });
      buttons[target].click();
    });
  });
  track.addEventListener('pointermove', (event) => {
    const d = drag;
    if (!d || event.pointerId !== d.id) return;
    const x = localX(event);
    if (
      !d.live &&
      Math.abs(event.clientY - d.y0) > SLOP &&
      Math.abs(event.clientY - d.y0) > Math.abs(x - d.x0)
    ) {
      cancel();
      return;
    }
    if (!d.onThumb) return;
    d.hist.push([event.timeStamp, x]);
    if (d.hist.length > 8) d.hist.shift();
    if (!d.live) {
      if (Math.abs(x - d.x0) < DEADZONE) return;
      d.live = true;
      d.offset = x - left;
      d.w = right - left;
      track.dataset.held = '';
    }
    const l = x - d.offset,
      max = innerWidth - d.w;
    if (reduce.matches) {
      left = clamp(l, 0, max);
      right = left + d.w;
    } else if (l < 0) {
      left = 0;
      right = d.w - rubber(-l, d.w);
    } else if (l > max) {
      right = innerWidth;
      left = max + rubber(l - max, d.w);
    } else {
      left = l;
      right = l + d.w;
    }
    paint();
  });
  track.addEventListener('pointerup', (event) => {
    const d = drag;
    if (!d || event.pointerId !== d.id) return;
    const rect = track.getBoundingClientRect();
    release();
    if (!d.live) {
      if (d.onThumb) land(active(), 0, false, false);
      return;
    }
    if (event.clientY < rect.top - SLOP || event.clientY > rect.bottom + SLOP) {
      suppressClick = true;
      land(active(), 0, false, false);
      return;
    }
    const recent = d.hist.filter(([t]) => event.timeStamp - t <= 100),
      first = recent[0],
      last = recent.at(-1);
    const velocity =
      first && last && last[0] - first[0] >= 8
        ? clamp(((last[1] - first[1]) / (last[0] - first[0])) * 1000, -2000, 2000)
        : 0;
    const decay = 1 - 0.1 * Math.pow(0.05, 0.75),
      projected = ((velocity / 1000) * decay) / (1 - decay);
    const target = nearest((left + right) / 2 + projected);
    if (target >= 0) {
      buttons[target].click();
      buttons[target].focus({ preventScroll: true });
    }
    // Respect a rejected business transition (e.g. unfinished retest).
    committed = active();
    land(committed, velocity, Math.abs(velocity) > 110, Math.abs(velocity) > 110);
    suppressClick = true;
  });
  track.addEventListener(
    'click',
    (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  track.addEventListener('pointercancel', cancel);
  track.addEventListener('lostpointercapture', () => {
    if (drag) cancel();
  });
  window.addEventListener('blur', cancel);
  const changes = new MutationObserver(() => {
    const next = active();
    if (next === committed) return;
    const previous = committed;
    committed = next;
    if (!drag) travel(previous, next);
  });
  changes.observe(track, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });
  new ResizeObserver(measure).observe(track);
  reduce.addEventListener('change', () => jump(active()));
  measure();
  document.fonts?.ready.then(measure);
}

// Keep the actual fixed player above an on-screen keyboard without shrinking
// the whole study workspace into a fixed-height box.
const player = document.querySelector('.player'),
  root = document.documentElement;
let viewportFrame = 0;
function updateViewport() {
  viewportFrame = 0;
  const vv = window.visualViewport;
  const editing = !!document.activeElement?.matches(
    'input:not([type="range"]):not([type="file"]),textarea,select,[contenteditable="true"]',
  );
  const obscured = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  const keyboard = editing && obscured > 100;
  root.classList.toggle('keyboard-open', keyboard);
  root.style.setProperty('--keyboard-offset', `${keyboard ? obscured : 0}px`);
  root.style.setProperty('--player-space', `${Math.ceil(player.getBoundingClientRect().height) + 20}px`);
  root.style.setProperty('--visible-height', `${vv?.height || window.innerHeight}px`);
}
function scheduleViewport() {
  if (!viewportFrame) viewportFrame = requestAnimationFrame(updateViewport);
}
if (player) {
  new ResizeObserver(scheduleViewport).observe(player);
  window.visualViewport?.addEventListener('resize', scheduleViewport);
  window.visualViewport?.addEventListener('scroll', scheduleViewport);
  window.addEventListener('resize', scheduleViewport);
  document.addEventListener('focusin', scheduleViewport);
  document.addEventListener('focusout', scheduleViewport);
  updateViewport();
}
