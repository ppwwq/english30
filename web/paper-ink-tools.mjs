import { confirmAction } from './confirmation.mjs';
import { inkColors } from './paper-ink-geometry.mjs';
import { inkIcon } from './ink-icons.mjs';

const modeNames = {
  pen: '钢笔',
  pencil: '铅笔',
  marker: '荧光笔',
  erase: '橡皮擦',
  line: '直线',
  lasso: '套索',
  pan: '移动纸面',
};
const colorNames = ['墨黑', '蓝', '红', '绿', '黄', '紫'];
export function mountInkTools(host, options, actions, reviewing = false) {
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', reviewing ? '原卷批改工具' : '原卷手写工具');
  const modes = new Map();
  let lastBrush = options.brushes[options.mode] ? options.mode : 'pen',
    state = {};
  function group(parent, cls, label) {
    const el = document.createElement('div');
    el.className = cls;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', label);
    parent.append(el);
    return el;
  }
  function button(parent, label, icon, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    inkIcon(b, icon, label);
    b.onclick = onClick;
    parent.append(b);
    return b;
  }
  const menus = [];
  function toggleMenu(active = null) {
    for (const { key, trigger, panel } of menus) {
      const open = key === active;
      trigger.setAttribute('aria-expanded', String(open));
      panel.dataset.open = String(open);
      if (key !== 'colors') panel.hidden = !open;
    }
  }
  function menu(parent, key, label, icon, cls = 'ink-popup') {
    const trigger = button(parent, label, icon, () =>
      toggleMenu(trigger.getAttribute('aria-expanded') === 'true' ? null : key),
    );
    trigger.setAttribute('aria-expanded', 'false');
    const panel = group(parent, cls, label);
    panel.id = 'ink-menu-' + key;
    trigger.setAttribute('aria-controls', panel.id);
    panel.hidden = key !== 'colors';
    menus.push({ key, trigger, panel });
    return { trigger, panel };
  }
  host.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !host.contains(e.relatedTarget) && !e.relatedTarget.closest?.('dialog'))
      toggleMenu();
  });
  host.addEventListener('ink-dismiss', () => toggleMenu());
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const active = menus.find((m) => m.trigger.getAttribute('aria-expanded') === 'true');
    if (active) {
      e.stopPropagation();
      toggleMenu();
      active.trigger.focus();
    }
  });
  function addMode(parent, key, icon) {
    const b = button(parent, modeNames[key], icon, () => {
      if ((key === 'erase' || key === 'marker') && options.mode === key && !b.closest('.ink-popup')) {
        toggleMenu(spec.panel.hidden ? 'spec' : null);
        return;
      }
      const fromPopup = b.closest('.ink-popup');
      toggleMenu();
      actions.mode(key);
      if (fromPopup) (b.closest('[hidden]') ? extra.trigger : b).focus();
    });
    modes.set(key, b);
  }
  const rack = group(host, 'ink-rack', '书写与擦除');
  for (const key of ['pen', 'pencil', 'marker', 'erase']) addMode(rack, key, 'rack-' + key);
  const extra = menu(rack, 'tools', '其他工具', 'more');
  for (const key of ['line', 'lasso', 'pan']) addMode(extra.panel, key, key);
  let compact = false;
  function arrangePens() {
    const primary = ['pen', 'pencil', 'marker'].includes(lastBrush) ? lastBrush : 'pen';
    for (const key of ['pen', 'pencil', 'marker']) {
      const node = modes.get(key);
      const parent = compact && key !== primary ? extra.panel : rack;
      if (node.parentNode !== parent)
        parent.insertBefore(node, parent === rack ? modes.get('erase') : modes.get('line'));
    }
    if (!compact)
      for (const key of ['pen', 'pencil', 'marker']) rack.insertBefore(modes.get(key), modes.get('erase'));
  }
  new ResizeObserver(([entry]) => {
    const next = entry.contentRect.width > 0 && entry.contentRect.width < (reviewing ? 450 : 540);
    if (next !== compact) {
      compact = next;
      arrangePens();
    }
  }).observe(host);
  const paint = group(host, 'ink-paint', '笔色和规格');
  const palette = menu(paint, 'colors', '选择笔色', 'swatch', 'ink-palette');
  palette.trigger.classList.add('ink-palette-trigger');
  const swatches = inkColors.map((color, i) => {
    const b = button(palette.panel, colorNames[i] + '色笔迹', 'swatch', () => {
      const mode = options.brushes[options.mode] ? options.mode : lastBrush;
      options.brushes[mode].color = color;
      toggleMenu();
      if (options.mode !== mode) actions.mode(mode);
      else refresh();
    });
    b.classList.add('ink-swatch');
    b.style.setProperty('--swatch', color);
    return b;
  });
  const spec = menu(paint, 'spec', '笔迹粗细', 'stroke-sample');
  const widthRow = group(spec.panel, 'ink-choices', '笔迹粗细');
  const eraseRow = group(spec.panel, 'ink-choices', '擦除方式');
  const radiusRow = group(spec.panel, 'ink-choices', '橡皮大小');
  const adjust = document.createElement('label');
  adjust.className = 'ink-preset-adjust';
  const adjustLabel = document.createElement('span'),
    value = document.createElement('output'),
    range = document.createElement('input');
  range.type = 'range';
  range.step = '1';
  adjust.append(adjustLabel, value, range);
  spec.panel.append(adjust);
  range.oninput = () => {
    if (options.mode === 'erase') options.eraseSizes[options.eraseSlot] = Number(range.value);
    else options.brushes.marker.widths[options.brushes.marker.size - 1] = Number(range.value);
    refresh();
  };
  const sizes = ['细', '中', '粗'].map((name, i) => {
    const b = button(widthRow, name + '笔迹', 'stroke-sample', () => {
      options.brushes[lastBrush].size = i + 1;
      if (options.mode !== lastBrush) actions.mode(lastBrush);
      else refresh();
      if (lastBrush !== 'marker') {
        toggleMenu();
        spec.trigger.focus();
      }
    });
    b.style.setProperty('--sample-width', [1.6, 3.4, 5.5][i]);
    return b;
  });
  const erasers = [
    ['partial', '局部擦除', 'erase-part'],
    ['whole', '整笔擦除', 'erase-whole'],
  ].map(([value, name, icon]) =>
    button(eraseRow, name, icon, () => {
      options.eraseMode = value;
      refresh();
      toggleMenu();
      spec.trigger.focus();
    }),
  );
  const radii = options.eraseSizes.map((size, i) => {
    const b = button(radiusRow, ['小橡皮', '中橡皮', '大橡皮'][i], 'radius', () => {
      options.eraseSlot = i;
      refresh();
    });
    b.style.setProperty('--radius-scale', [0.48, 0.72, 1][i]);
    return b;
  });
  const selection = group(host, 'ink-selection-actions', '套索选区');
  button(selection, '复制选中', 'copy', actions.copy);
  button(selection, '删除选中', 'delete', actions.remove);
  const history = group(host, 'ink-history', '编辑操作');
  const undo = button(history, '撤销', 'undo', actions.undo),
    redo = button(history, '重做', 'redo', actions.redo);
  const menuHistory = group(extra.panel, 'ink-choices ink-menu-history', '编辑操作');
  const menuUndo = button(menuHistory, '撤销', 'undo', actions.undo);
  const menuRedo = button(menuHistory, '重做', 'redo', actions.redo);
  extra.panel.prepend(menuHistory);
  const prefs = menu(history, 'settings', '书写设置', 'settings');
  const finger = button(prefs.panel, '手指也可书写', 'write', () => {
    options.finger = options.finger === 'draw' ? 'pan' : 'draw';
    refresh();
  });
  const clear = button(prefs.panel, reviewing ? '清空本页批注' : '清空本页', 'clear', async () => {
    const { pageKey } = state;
    const target = reviewing ? '批注' : '笔迹';
    clear.focus({ preventScroll: true });
    if (
      await confirmAction('清空本页' + target + '？', '仅清空当前页的' + target + '，可以撤销。', '清空本页')
    ) {
      if (!host.isConnected || pageKey !== state.pageKey) return;
      actions.clear();
      toggleMenu();
      prefs.trigger.focus();
    }
  });
  function mark(b, on) {
    b.setAttribute('aria-pressed', String(on));
  }
  function updateIcon(b, icon, label) {
    if (b.dataset.icon === icon) {
      b.title = label;
      b.setAttribute('aria-label', label);
      return;
    }
    inkIcon(b, icon, label);
    b.dataset.icon = icon;
  }
  function refresh(next) {
    if (next) state = next;
    if (options.brushes[options.mode] && options.mode !== lastBrush) {
      lastBrush = options.mode;
      if (compact) arrangePens();
    }
    const brush = options.brushes[lastBrush],
      isErase = options.mode === 'erase';
    for (const [key, b] of modes) {
      mark(b, key === options.mode);
      if (options.brushes[key]) b.style.setProperty('--nib', options.brushes[key].color);
    }
    const aux = ['line', 'lasso', 'pan'].includes(options.mode);
    updateIcon(extra.trigger, 'more', '其他工具');
    extra.trigger.dataset.active = String(aux);
    swatches.forEach((b, i) => mark(b, inkColors[i] === brush.color));
    palette.trigger.style.setProperty('--swatch', brush.color);
    const colorName = colorNames[inkColors.indexOf(brush.color)];
    palette.trigger.title = palette.trigger.ariaLabel = '选择笔色，当前' + colorName;
    widthRow.hidden = isErase;
    eraseRow.hidden = radiusRow.hidden = !isErase;
    updateIcon(
      spec.trigger,
      isErase ? 'radius' : 'stroke-sample',
      isErase ? '橡皮设置' : lastBrush === 'marker' ? '荧光笔粗细' : '笔迹粗细',
    );
    spec.trigger.style.setProperty('--sample-color', brush.color);
    spec.trigger.style.setProperty(
      '--sample-width',
      lastBrush === 'marker' ? brush.widths[brush.size - 1] / 4 + 1 : [1.6, 3.4, 5.5][brush.size - 1],
    );
    spec.trigger.style.setProperty(
      '--sample-opacity',
      lastBrush === 'marker' ? '0.48' : lastBrush === 'pencil' ? '0.72' : '1',
    );
    const radiusScale = (r) => 0.28 + (r / 40) * 0.95;
    spec.trigger.style.setProperty(
      '--radius-scale',
      String(radiusScale(options.eraseSizes[options.eraseSlot])),
    );
    sizes.forEach((b, i) => {
      mark(b, i + 1 === brush.size);
      b.style.setProperty('--sample-color', brush.color);
      b.style.setProperty(
        '--sample-width',
        lastBrush === 'marker' ? brush.widths[i] / 4 + 1 : [1.6, 3.4, 5.5][i],
      );
      b.style.setProperty('--sample-opacity', lastBrush === 'marker' ? '0.48' : '1');
      b.setAttribute(
        'aria-label',
        lastBrush === 'marker' ? '荧光笔档位 ' + (i + 1) : ['细笔迹', '中笔迹', '粗笔迹'][i],
      );
      b.title = b.getAttribute('aria-label');
    });
    erasers.forEach((b, i) => mark(b, options.eraseMode === (i ? 'whole' : 'partial')));
    radii.forEach((b, i) => {
      mark(b, options.eraseSlot === i);
      b.setAttribute('aria-label', '橡皮档位 ' + (i + 1));
      b.title = b.getAttribute('aria-label');
      b.style.setProperty('--radius-scale', String(radiusScale(options.eraseSizes[i])));
    });
    adjust.hidden = !isErase && lastBrush !== 'marker';
    if (!adjust.hidden) {
      const slot = isErase ? options.eraseSlot : brush.size - 1;
      adjustLabel.textContent = (isErase ? '橡皮半径' : '荧光笔宽') + ' · 档 ' + (slot + 1);
      range.setAttribute('aria-label', adjustLabel.textContent);
      range.min = isErase ? '2' : '3';
      range.max = isErase ? '40' : '48';
      range.value = String(isErase ? options.eraseSizes[slot] : brush.widths[slot]);
      value.value = isErase ? range.value + ' px' : (Number(range.value) / 10).toFixed(1) + '%';
      range.setAttribute('aria-valuetext', value.value);
      if (!isErase) value.title = '占原卷宽度的比例';
      else value.removeAttribute('title');
    }
    mark(finger, options.finger === 'draw');
    selection.hidden = !state.selected;
    undo.disabled = menuUndo.disabled = !state.canUndo;
    redo.disabled = menuRedo.disabled = !state.canRedo;
    clear.disabled = !state.hasInk;
  }
  return refresh;
}
