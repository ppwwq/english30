const ns = 'http://www.w3.org/2000/svg';
export function inkIcon(control, name, label) {
  control.classList.add('ink-icon-control');
  control.setAttribute('aria-label', label);
  control.title = label;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', new URL('./ink-icons.svg#' + name, import.meta.url).href);
  svg.append(use);
  control.replaceChildren(svg);
}
