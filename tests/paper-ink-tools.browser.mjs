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
  page.on('dialog', (d) => d.accept());
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
    assert.equal((await control.innerText()).trim(), '', 'handwriting actions use icons');
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
  await draw(
    [
      [30, 50],
      [90, 50],
    ],
    'touch',
  );
  assert.equal(await strokes.count(), 0, 'finger pans by default');
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
  await btn('撤销').click();
  assert.equal(await strokes.count(), 1);
  await btn('重做').click();
  assert.equal(await strokes.count(), 2);
  await btn('橡皮设置').click();
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
