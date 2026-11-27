import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const books = JSON.parse(
    await readFile(new URL('../web/papers/answer-books.json', import.meta.url), 'utf8'),
  );
  if (!books['reading-2025-exam-A']) throw Error('阅读原卷的答题册页表未生成。');
  await Promise.all(
    Object.values(books).flatMap((b) =>
      [...b.pages, ...(b.data || [])].map((p) =>
        access(new URL('../web/papers/print/' + p.master + '.jpg', import.meta.url)),
      ),
    ),
  );
} catch {
  const result = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['scripts/build-answer-books.py'],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error('无法生成答题册原页。请先恢复原卷媒体，并安装 Python 和 Pillow。');
    process.exitCode = 1;
  }
}
