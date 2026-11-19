// Move the live transcript so scrolling, word marks and the audio clock stay shared.
export function mountTranscriptWindow() {
  const panel = document.querySelector('.transcript-panel');
  const home = document.createComment('transcript');
  panel.before(home);
  const inspector = document.querySelector('#word-inspector');
  const inspectorHome = document.createComment('word inspector');
  inspector.before(inspectorHome);
  const grip = panel.querySelector('.caption-grip');
  const resize = panel.querySelector('.caption-resize');
  const maximize = panel.querySelector('.caption-maximize');
  let available = false,
    open = false,
    maximized = false,
    docked = false,
    geometry;
  const clamp = (n, low, high) => Math.max(low, Math.min(n, high));

  function layout() {
    if (!open) return;
    const w = document.documentElement.clientWidth,
      h = window.innerHeight,
      pad = 6;
    const playerTop = document.querySelector('.player').getBoundingClientRect().top;
    const bottom = playerTop > h / 2 && playerTop < h ? playerTop : h;
    geometry ??= {
      x: 18,
      y: Math.max(16, bottom - 264),
      width: Math.min(w - 32, 390),
      height: 242,
    };
    const g = maximized ? { x: pad, y: pad, width: w, height: bottom - 2 * pad } : geometry;
    const width = clamp(g.width, Math.min(258, w - 2 * pad), w - 2 * pad);
    const height = clamp(g.height, Math.min(165, h - 2 * pad), h - 2 * pad);
    Object.assign(panel.style, {
      width: width + 'px',
      height: height + 'px',
      left: clamp(g.x, pad, w - width - pad) + 'px',
      top: clamp(g.y, pad, h - height - pad) + 'px',
    });
  }
  function setOpen(value) {
    open = value && available;
    panel.classList.toggle('is-floating', open);
    if (open) {
      const parent =
        document.querySelector('.practice-page-dialog[open]') || document.querySelector('#listening-panel');
      parent.append(panel);
      panel.insertBefore(inspector, resize);
      layout();
      panel.dispatchEvent(new Event('transcript-layout'));
    } else {
      home.after(panel);
      inspectorHome.after(inspector);
      panel.style.removeProperty('width');
      panel.style.removeProperty('height');
      panel.style.removeProperty('left');
      panel.style.removeProperty('top');
    }
    const toggle = document.querySelector('#paper-float-transcript');
    toggle?.setAttribute('aria-pressed', String(open));
  }
  function dock() {
    docked = true;
    setOpen(false);
    document.querySelector('#paper-float-transcript')?.focus({ preventScroll: true });
  }
  panel.querySelector('.caption-dock').onclick = dock;
  maximize.onclick = () => {
    maximized = !maximized;
    maximize.setAttribute('aria-label', maximized ? '还原大小' : '最大化字幕');
    maximize.title = maximize.getAttribute('aria-label');
    maximize.setAttribute('aria-pressed', String(maximized));
    resize.hidden = maximized;
    layout();
    panel.dispatchEvent(new Event('transcript-layout'));
  };
  function adjust(handle, sizing) {
    let start;
    function change(box, dx, dy) {
      geometry = sizing
        ? {
            x: box.x,
            y: box.y,
            width: Math.min(innerWidth - box.x - 6, box.width + dx),
            height: Math.min(innerHeight - box.y - 6, box.height + dy),
          }
        : { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
      layout();
    }
    handle.onpointerdown = (event) => {
      if (!open || maximized || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      start = { id: event.pointerId, x: event.clientX, y: event.clientY, box: panel.getBoundingClientRect() };
      handle.setPointerCapture(event.pointerId);
    };
    handle.onpointermove = (event) => {
      if (event.pointerId === start?.id) change(start.box, event.clientX - start.x, event.clientY - start.y);
    };
    handle.onlostpointercapture = () => {
      start = null;
    };
    handle.onkeydown = (event) => {
      const step = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[
        event.key
      ];
      if (!step || !open || maximized) return;
      event.preventDefault();
      event.stopPropagation();
      change(panel.getBoundingClientRect(), ...step);
    };
  }
  adjust(grip, false);
  adjust(resize, true);
  window.addEventListener('resize', layout);
  return {
    enable(value) {
      available = value;
      if (!value) {
        if (open) setOpen(false);
        docked = false;
      }
    },
    toggle() {
      if (open) dock();
      else {
        docked = false;
        setOpen(true);
      }
    },
    showForPlayback() {
      if (available && !docked && !open) setOpen(true);
    },
    paperDialogChanged() {
      if (open) setOpen(true);
    },
    get open() {
      return open;
    },
  };
}
