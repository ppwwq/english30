import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium, webkit, devices } = require('playwright');
const useWebKit = process.argv.includes('--webkit');
const browser = await (useWebKit ? webkit : chromium).launch({
  executablePath: useWebKit ? undefined : process.env.CHROMIUM_EXECUTABLE,
});
try {
  const page = await browser.newPage(devices['iPad Pro 11 landscape']);
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  allowBeforeUnload(page);
  await page.goto((process.env.TEST_URL || 'http://127.0.0.1:4174') + '/#listening');
  const btn = (name) => page.getByRole('button', { name, exact: true });
  await btn('手写作答').click();
  const svg = page.locator('.paper-ink');
  const strokes = svg.locator('g').first().locator('.ink-stroke');
  const img = page.locator('#practice-image');
  await img.evaluate((i) => i.decode());
  const iconButtons = page.locator(
    '.paper-writing-sheet button:visible, .paper-writing-sheet summary:visible, #submit-answers',
  );
  for (const control of await iconButtons.all()) {
    const text = (await control.innerText()).trim();
    if (await control.locator('.paper-control-label').count()) {
      assert.ok(['打字', '手写', '退出全屏', 'Data File', '回到原题'].includes(text));
    } else assert.equal(text, '', 'pen tools stay icon-only');
    assert.ok(await control.getAttribute('aria-label'), 'each icon has an accessible name');
    assert.equal(await control.locator('svg use').count(), 1);
    const box = await control.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, 'icon remains a touch target');
  }
  async function draw(points, type = 'pen', cancel = false) {
    const b = await svg.boundingBox();
    for (let i = 0; i < points.length; i++) {
      const [x, y, p = 0.65] = points[i];
      await svg.dispatchEvent(
        i === 0
          ? 'pointerdown'
          : i === points.length - 1
            ? cancel
              ? 'pointercancel'
              : 'pointerup'
            : 'pointermove',
        {
          pointerId: 1,
          pointerType: type,
          clientX: b.x + x,
          clientY: b.y + y,
          pressure: p,
          button: 0,
          tiltX: 20,
        },
      );
    }
  }
  const zoom = btn('调整纸面缩放');
  const title = page.locator('.paper-focus-context');
  assert.match(await title.innerText(), /2025 Part A · Task 1/);
  async function outsideTap(trigger) {
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await title.dispatchEvent('pointerdown', { pointerType: 'touch' });
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  }
  await outsideTap(zoom);
  await outsideTap(btn('其他工具'));
  await zoom.click();
  await page.keyboard.press('Escape');
  assert.equal(await zoom.getAttribute('aria-expanded'), 'false');
  assert.equal(await btn('退出全屏').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await btn('全屏书写').isVisible(), true);
  await btn('全屏书写').click();
  const zoomSlider = page.getByRole('slider', { name: '纸面缩放比例' });
  const changeRange = (slider, value) =>
    slider.evaluate((node, v) => {
      node.value = v;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
  await zoom.click();
  assert.equal(await zoomSlider.inputValue(), '80');
  await btn('恢复适合宽度').click();
  const baseWidth = (await svg.boundingBox()).width;
  for (const percent of [35, 73, 173, 300]) {
    await changeRange(zoomSlider, percent);
    assert.ok(Math.abs((await svg.boundingBox()).width / baseWidth - percent / 100) < 0.025);
    assert.equal(await img.boundingBox().then((b) => b.width), await svg.boundingBox().then((b) => b.width));
  }
  await btn('恢复适合宽度').click();
  await zoom.click();
  const wrap = page.locator('.practice-page-wrap');
  const viewport = await wrap.boundingBox();
  const touchPoint = (kind, id, x, y = 130, target = svg) =>
    target.dispatchEvent('pointer' + kind, {
      pointerType: 'touch',
      pointerId: id,
      button: 0,
      clientX: viewport.x + x,
      clientY: viewport.y + y,
    });
  if (useWebKit) {
    await touchPoint('down', 20, 220);
    await touchPoint('down', 21, 320);
    await touchPoint('move', 21, 410);
    await touchPoint('up', 21, 410);
    await touchPoint('up', 20, 220);
  } else {
    const cdp = await page.context().newCDPSession(page);
    const finger = (id, x) => ({ id, x: viewport.x + x, y: viewport.y + 130 });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [finger(20, 220), finger(21, 320)],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [finger(20, 220), finger(21, 410)],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
  await zoom.click();
  assert.equal(await zoomSlider.inputValue(), '190');
  assert.equal(await strokes.count(), 0, 'pinch does not leave ink');
  await btn('恢复适合宽度').click();
  await zoom.click();
  await draw(
    [
      [30, 50],
      [90, 50],
    ],
    'touch',
  );
  assert.equal(await strokes.count(), 0, 'finger pans by default');
  const top = () => wrap.evaluate((node) => node.scrollTop);
  const beforePalm = await top();
  await touchPoint('down', 22, 260);
  await draw([
    [50, 90],
    [100, 95],
  ]);
  await touchPoint('move', 22, 260, 45);
  assert.equal(await top(), beforePalm, 'resting palm stays suppressed after a stroke');
  await draw([
    [55, 110],
    [105, 115],
  ]);
  assert.equal(await strokes.count(), 2, 'the same resting palm does not block later pen strokes');
  await touchPoint('up', 22, 260, 45);
  await btn('撤销').click();
  await btn('撤销').click();

  await btn('其他工具').click();
  await btn('移动纸面').click();
  const x = Math.round(viewport.x + viewport.width / 2);
  const y = Math.round(viewport.y + 185);
  const resetPan = () => wrap.evaluate((node) => node.scrollTo(0, 0));
  await resetPan();
  if (useWebKit) {
    // WebKit's test driver has no native stylus input. Verify the capture request
    // before simulating loss of capture from a contact released off the page.
    const captureRequested = await img.evaluate(
      (node, { x, y }) => {
        const surface = node.closest('.practice-page-wrap');
        const capture = surface.setPointerCapture;
        let requested = false;
        surface.setPointerCapture = (id) => {
          requested = id === 30;
        };
        try {
          node.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              pointerType: 'pen',
              pointerId: 30,
              clientX: x,
              clientY: y,
            }),
          );
          node.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              cancelable: true,
              pointerType: 'pen',
              pointerId: 30,
              clientX: x,
              clientY: y - 90,
            }),
          );
          surface.dispatchEvent(
            new PointerEvent('lostpointercapture', { pointerType: 'pen', pointerId: 30 }),
          );
          return requested;
        } finally {
          surface.setPointerCapture = capture;
        }
      },
      { x, y },
    );
    assert.equal(captureRequested, true);
  } else {
    const cdp = await page.context().newCDPSession(page);
    const pen = (type, y, buttons) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', button: 'left', buttons });
    await pen('mousePressed', y, 1);
    await pen('mouseMoved', y - 90, 1);
    await pen('mouseReleased', Math.floor(viewport.y - 5), 0);
    await cdp.detach();
  }
  assert.ok((await top()) > 50, 'pen drags the paper in pan mode');
  await resetPan();
  await touchPoint('down', 31, 260, 185, img);
  await touchPoint('move', 31, 260, 85, img);
  await touchPoint('up', 31, 260, 85, img);
  assert.ok((await top()) > 50, 'touch pans after releasing the pen outside the paper');
  await resetPan();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 90);
  await page.mouse.up();
  assert.ok((await top()) > 50, 'mouse drags the paper in pan mode');
  assert.equal(await strokes.count(), 0, 'pan never writes ink');
  await resetPan();
  await btn('钢笔').click();
  await draw([
    [40, 90, 0.08],
    [120, 90, 0.8],
    [220, 90, 0.8],
  ]);
  assert.equal(await strokes.count(), 1);
  await btn('橡皮擦').click();
  await draw([
    [133, 58],
    [133, 120],
  ]);
  assert.equal(await strokes.count(), 2, 'partial eraser cuts one stroke into two fragments');
  await btn('其他工具').click();
  const menu = page.locator('#ink-menu-tools');
  await menu.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await strokes.count(), 1);
  await menu.getByRole('button', { name: '重做', exact: true }).click();
  await btn('其他工具').click();
  assert.equal(await strokes.count(), 2);
  await btn('橡皮设置').click();
  for (const [slot, value] of [
    [1, 4],
    [2, 11],
    [3, 28],
  ]) {
    await btn('橡皮档位 ' + slot).click();
    await changeRange(page.getByRole('slider', { name: '橡皮半径 · 档 ' + slot }), value);
  }
  await btn('橡皮档位 2').click();
  assert.equal(await page.getByRole('slider', { name: '橡皮半径 · 档 2' }).inputValue(), '11');
  await btn('整笔擦除').click();
  await draw([
    [70, 80],
    [70, 100],
  ]);
  assert.equal(await strokes.count(), 1);
  await btn('其他工具').click();
  await btn('套索').click();
  await draw([
    [130, 60],
    [240, 60],
    [240, 125],
    [130, 125],
    [130, 60],
  ]);
  assert.ok(await btn('复制选中').isVisible());
  await btn('复制选中').click();
  assert.equal(await strokes.count(), 2);
  const before = await strokes.last().getAttribute('d');
  await draw([
    [196, 108],
    [200, 125],
    [217, 140],
  ]);
  assert.notEqual(await strokes.last().getAttribute('d'), before, 'selected ink moves');
  await btn('删除选中').click();
  assert.equal(await strokes.count(), 1);
  await btn('荧光笔').click();
  await btn('荧光笔粗细').click();
  for (const [slot, value] of [
    [1, 7],
    [2, 16],
    [3, 32],
  ]) {
    await btn('荧光笔档位 ' + slot).click();
    await changeRange(page.getByRole('slider', { name: '荧光笔宽 · 档 ' + slot }), value);
  }
  await btn('荧光笔档位 2').click();
  assert.equal(await page.getByRole('slider', { name: '荧光笔宽 · 档 2' }).inputValue(), '16');
  await btn('荧光笔粗细').click();
  await draw([
    [60, 150],
    [180, 150],
  ]);
  assert.equal(await strokes.last().getAttribute('opacity'), '0.38');
  await btn('其他工具').click();
  await btn('直线').click();
  await draw([
    [60, 170],
    [130, 200],
    [180, 170],
  ]);
  await btn('铅笔').click();
  await draw([
    [60, 220, 0.1],
    [110, 225, 0.8],
    [180, 222, 0.4],
  ]);
  assert.equal(await strokes.count(), 4);
  await draw(
    [
      [50, 240],
      [110, 240],
    ],
    'pen',
    true,
  );
  assert.equal(await strokes.count(), 4);
  await btn('书写设置').click();
  await btn('手指也可书写').click();
  await btn('蓝色笔迹').click();
  assert.equal(await btn('蓝色笔迹').getAttribute('aria-pressed'), 'true');
  await draw(
    [
      [65, 245],
      [121, 249],
    ],
    'touch',
  );
  assert.equal(await strokes.last().getAttribute('fill'), '#254c8b');
  await btn('书写设置').click();
  await btn('清空本页').click();
  const dialog = page.getByRole('dialog', { name: '清空本页笔迹？' });
  assert.equal(
    await dialog.getByRole('button', { name: '取消' }).evaluate((n) => n === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(await strokes.count(), 5);
  assert.equal(await btn('退出全屏').isVisible(), true);
  assert.equal(await btn('清空本页').evaluate((n) => n === document.activeElement), true);
  await btn('清空本页').click();
  await answerConfirmation(page, '清空本页');
  assert.equal(await strokes.count(), 0);
  await btn('撤销').click();
  assert.equal(await strokes.count(), 5);
  await page.reload();
  await svg.waitFor();
  assert.equal(await strokes.count(), 5, 'all styles recover after refresh');
  assert.equal(await strokes.last().getAttribute('fill'), '#254c8b');
  await btn('红色笔迹').click();
  await btn('荧光笔').click();
  assert.equal(await btn('黄色笔迹').getAttribute('aria-pressed'), 'true');
  await btn('钢笔').click();
  assert.equal(await btn('红色笔迹').getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  const color = page.getByRole('button', { name: /选择笔色/ });
  await color.waitFor();
  await menu.locator('button[aria-label="铅笔"]').waitFor({ state: 'attached' });
  const paperBefore = await svg.boundingBox();
  await color.click();
  assert.ok(await btn('紫色笔迹').isVisible());
  const lastColor = await btn('紫色笔迹').boundingBox();
  assert.ok(lastColor.x >= 0 && lastColor.x + lastColor.width <= 390);
  await btn('紫色笔迹').click();
  assert.equal((await svg.boundingBox()).y, paperBefore.y);
  assert.equal(
    await btn('橡皮擦')
      .boundingBox()
      .then((b) => b.y),
    await btn('撤销')
      .boundingBox()
      .then((b) => b.y),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS pen, pencil, highlighter, line, both erasers, lasso move/copy/delete, touch mode, undo/redo and reload in ' +
      (useWebKit ? 'WebKit' : 'Chromium'),
  );
} finally {
  await browser.close();
}
