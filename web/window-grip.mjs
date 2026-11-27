const arrowSteps = new Map([
  ['ArrowLeft', [-16, 0]],
  ['ArrowRight', [16, 0]],
  ['ArrowUp', [0, -16]],
  ['ArrowDown', [0, 16]],
]);

export function bindWindowGrip(handle, { read, change, active = () => true }) {
  let start;
  handle.onpointerdown = (event) => {
    if (!active() || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, box: read() };
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = (event) => {
    if (event.pointerId === start?.id) change(start.box, event.clientX - start.x, event.clientY - start.y);
  };
  handle.onlostpointercapture = () => {
    start = null;
  };
  handle.onkeydown = (event) => {
    const step = arrowSteps.get(event.key);
    if (!step || !active()) return;
    event.preventDefault();
    event.stopPropagation();
    change(read(), ...step);
  };
}
