const svgNS = 'http://www.w3.org/2000/svg';

// The image and its overlay share a box, including during zoom and rotation.
export function mountPaperInk(stage, tools, writing) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('paper-ink');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-label', '原卷手写笔迹');
  stage.append(svg);
  let pageKey,
    pointer = null,
    line,
    points,
    pan = false;
  function stroke(value) {
    const node = document.createElementNS(svgNS, 'polyline');
    node.setAttribute('points', value);
    node.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(node);
    return node;
  }
  const panButton = document.createElement('button');
  panButton.type = 'button';
  panButton.textContent = '移动纸面';
  panButton.setAttribute('aria-pressed', 'false');
  panButton.onclick = () => {
    pan = !pan;
    panButton.setAttribute('aria-pressed', String(pan));
    svg.classList.toggle('can-pan', pan);
  };
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = '撤销一笔';
  undo.onclick = () => {
    writing.ink[pageKey]?.pop();
    if (!writing.ink[pageKey]?.length) delete writing.ink[pageKey];
    show(pageKey);
    writing.changed();
  };
  if (!writing.readOnly) tools.append(panButton, undo);

  function appendPoint(event) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const unit = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000);
    const point =
      unit((event.clientX - rect.left) / rect.width) + ',' + unit((event.clientY - rect.top) / rect.height);
    if (points.at(-1) !== point) points.push(point);
  }
  function finish() {
    if (pointer === null) return;
    pointer = null;
    if (!points.length) {
      line.remove();
      return;
    }
    if (points.length === 1) points.push(points[0]);
    const value = points.join(' ');
    line.setAttribute('points', value);
    (writing.ink[pageKey] ||= []).push(value);
    undo.disabled = false;
    writing.changed();
  }
  svg.onpointerdown = (event) => {
    if (!pageKey || writing.readOnly || pan || pointer !== null || event.button !== 0) return;
    event.preventDefault();
    pointer = event.pointerId;
    try {
      svg.setPointerCapture(pointer);
    } catch {
      /* Some input devices release capture early. */
    }
    points = [];
    appendPoint(event);
    line = stroke(points.join(' '));
  };
  svg.onpointermove = (event) => {
    if (event.pointerId !== pointer) return;
    for (const sample of event.getCoalescedEvents?.() || []) appendPoint(sample);
    appendPoint(event);
    line.setAttribute('points', points.join(' '));
  };
  svg.onpointerup = (event) => {
    if (event.pointerId === pointer) {
      appendPoint(event);
      finish();
    }
  };
  svg.onpointercancel = svg.onlostpointercapture = (event) => {
    if (event.pointerId === pointer) finish();
  };
  function show(key) {
    finish();
    pageKey = key;
    svg.replaceChildren();
    svg.style.display = key ? '' : 'none';
    panButton.hidden = undo.hidden = !key;
    undo.disabled = !writing.ink[key]?.length;
    for (const value of writing.ink[key] || []) stroke(value);
    svg.classList.toggle('read-only', writing.readOnly);
  }
  return { show };
}
