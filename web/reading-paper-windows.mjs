import { bindWindowGrip } from './window-grip.mjs';

const gap = 8;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

function control(className, text, label = text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function defaultBoxes(width, height, count) {
  if ((width >= 900 && matchMedia('(orientation: landscape)').matches) || count < 3) {
    const column = (width - gap * (count - 1)) / count;
    return Array.from({ length: count }, (_, i) => ({
      x: i * (column + gap),
      y: 0,
      width: column,
      height,
    }));
  }
  const halfHeight = (height - gap) / 2;
  const halfWidth = (width - gap) / 2;
  return [
    { x: 0, y: 0, width, height: halfHeight },
    { x: 0, y: halfHeight + gap, width: halfWidth, height: halfHeight },
    { x: halfWidth + gap, y: halfHeight + gap, width: halfWidth, height: halfHeight },
  ];
}

export function mountReadingPaperWindows({ desktop, toolbar, views }) {
  let size,
    changed = false,
    layer = 0,
    topWindow;
  const entries = views.map(({ kind, title, section }) => {
    const pane = document.createElement('section');
    pane.className = 'reading-paper-window';
    pane.dataset.window = kind;
    pane.setAttribute('aria-label', title);
    const titlebar = document.createElement('div');
    titlebar.className = 'reading-paper-window-titlebar';
    const move = control('reading-paper-window-title', title, `移动${title}`);
    const close = control('reading-paper-window-close', '×', `关闭${title}视窗`);
    const resize = control('reading-paper-window-resize', '', `调整${title}视窗大小`);
    const restore = control('button-secondary', title, `切到${title}视窗`);
    move.dataset.windowMove = close.dataset.windowClose = resize.dataset.windowResize = '';
    titlebar.append(move, close);
    pane.append(titlebar, resize);
    desktop.append(pane);
    toolbar.append(restore);
    restore.dataset.windowSwitch = kind;
    const page = section.querySelector('.reading-paper-page');
    const entry = { kind, pane, section, page, move, restore, scroll: null, box: null };
    moveSection(section, pane, resize);

    function bringToFront() {
      if (topWindow === pane) return;
      topWindow = pane;
      pane.style.zIndex = String(++layer);
    }
    pane.addEventListener('pointerdown', bringToFront);
    pane.addEventListener('focusin', bringToFront);
    function updateSwitch(isClosed) {
      const label = isClosed ? `显示${title}` : `切到${title}视窗`;
      restore.dataset.closed = String(isClosed);
      restore.textContent = isClosed ? label : title;
      restore.setAttribute('aria-label', label);
      restore.title = label;
    }
    function closeWindow() {
      if (pane.hidden || !pane.isConnected) return;
      entry.scroll = [page.scrollLeft, page.scrollTop];
      updateSwitch(true);
      restore.focus({ preventScroll: true });
      pane.hidden = true;
    }
    close.onclick = closeWindow;
    let closeTap;
    close.onpointerdown = (event) => {
      if (event.pointerType === 'touch' && event.isPrimary)
        closeTap = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    close.onpointermove = (event) => {
      if (
        closeTap?.id === event.pointerId &&
        Math.hypot(event.clientX - closeTap.x, event.clientY - closeTap.y) > 8
      )
        closeTap = null;
    };
    close.onpointerup = (event) => {
      if (closeTap?.id !== event.pointerId) return;
      closeTap = null;
      if (!close.contains(document.elementFromPoint(event.clientX, event.clientY))) return;
      // A touch release immediately after a drag may not produce a native click.
      requestAnimationFrame(closeWindow);
    };
    close.onpointercancel = () => {
      closeTap = null;
    };
    restore.onclick = () => {
      const wasClosed = pane.hidden;
      pane.hidden = false;
      if (wasClosed && entry.scroll) page.scrollTo(...entry.scroll);
      move.focus({ preventScroll: true });
      updateSwitch(false);
    };

    const active = () => !!entry.box && !pane.hidden;
    const read = () => entry.box;
    bindWindowGrip(move, {
      active,
      read,
      change: (box, dx, dy) => adjust(entry, { ...box, x: box.x + dx, y: box.y + dy }),
    });
    bindWindowGrip(resize, {
      active,
      read,
      change: (box, dx, dy) =>
        adjust(entry, {
          ...box,
          width: Math.min(box.width + dx, size.width - box.x),
          height: Math.min(box.height + dy, size.height - box.y),
        }),
    });
    return entry;
  });

  function adjust(entry, box) {
    changed = true;
    place(entry, box);
  }

  function place(entry, box) {
    const { width, height } = size;
    const w = clamp(box.width, Math.min(248, width), width);
    const h = clamp(box.height, Math.min(225, height), height);
    const x = clamp(box.x, 0, width - w);
    const y = clamp(box.y, 0, height - h);
    entry.box = { x, y, width: w, height: h };
    Object.assign(entry.pane.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  }

  function layout(reset = false) {
    const width = desktop.clientWidth;
    const height = desktop.clientHeight;
    if (!width || !height) return;
    const before = size;
    if (reset) changed = false;
    if (!reset && before?.width === width && before?.height === height) return;
    size = { width, height };
    const defaults = defaultBoxes(width, height, entries.length);
    entries.forEach((entry, i) => {
      if (!changed || !before) place(entry, defaults[i]);
      else {
        const horizontal = width / before.width;
        const vertical = height / before.height;
        const { x, y, width: w, height: h } = entry.box;
        place(entry, { x: x * horizontal, y: y * vertical, width: w * horizontal, height: h * vertical });
      }
    });
  }

  const observer = new ResizeObserver(() => layout());
  observer.observe(desktop);
  layout();
  return {
    reset() {
      layout(true);
    },
    focusReference() {
      entries.at(-1)?.move.focus({ preventScroll: true });
    },
    destroy(restoreDocuments) {
      observer.disconnect();
      for (const { kind, pane, section, page, restore, scroll } of entries) {
        if (restoreDocuments && kind !== 'reference') {
          moveSection(section, desktop);
          if (pane.hidden && scroll) page.scrollTo(...scroll);
        }
        pane.remove();
        restore.remove();
      }
    },
  };
}

function moveSection(section, destination, before = null) {
  const page = section.querySelector('.reading-paper-page');
  const { scrollLeft, scrollTop } = page;
  destination.insertBefore(section, before);
  page.scrollTo(scrollLeft, scrollTop);
}
