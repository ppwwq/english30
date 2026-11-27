import { renderStroke } from './paper-ink.mjs';
import { taskQuestionPages } from './paper-question-pages.mjs';

export function paperSaveInfo(lesson) {
  if (!lesson?.paper) return null;
  const p = lesson.paper,
    spans = taskQuestionPages(lesson);
  return {
    sessionId: p.sessionId,
    part: p.part,
    task: p.task,
    source: p.questionSourceId,
    questionPage: p.questionPage,
    labels: Object.fromEntries(
      lesson.questions.map((q) => [
        q.id,
        {
          label: q.label || 'Q' + q.number,
          page:
            spans.find(([, first, last]) => q.number >= first && q.number <= last)?.[0] ??
            (p.part === 'B1' ? p.questionPage : null),
        },
      ]),
    ),
  };
}
async function decoded(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}
const jpg = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(Error('整页图生成失败。'))), 'image/jpeg', 0.97),
  );
const canvasOf = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};
export async function handwrittenImage(page, strokes, src) {
  const canvas = canvasOf(page.width, page.height),
    ctx = canvas.getContext('2d');
  try {
    const original = await decoded(src);
    if (original.naturalWidth !== page.width || original.naturalHeight !== page.height)
      throw Error('原页尺寸发生变化，请重试。');
    ctx.drawImage(original, 0, 0);
    const aspect = page.height / page.width;
    ctx.scale(page.width / 1000, page.width / 1000);
    for (const stroke of strokes) {
      const el = renderStroke(stroke, aspect);
      if (el.tagName.toLowerCase() === 'path') {
        ctx.fillStyle = el.getAttribute('fill');
        ctx.globalAlpha = Number(el.getAttribute('opacity'));
        ctx.fill(new Path2D(el.getAttribute('d')));
      } else {
        const points = el
          .getAttribute('points')
          .split(' ')
          .map((p) => p.split(',').map(Number));
        ctx.strokeStyle = '#24241f';
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (const [i, [x, y]] of points.entries()) {
          if (!i) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    return await jpg(canvas);
  } finally {
    canvas.width = canvas.height = 1;
  }
}

export async function typedImages(info, attempt, onPage) {
  if (info.paper !== 1 && attempt.ink) return;
  const groups = new Map();
  const reading = info.paper === 1;
  const answers = reading ? attempt.answers : attempt.results;
  for (const [id, result] of Object.entries(answers)) {
    const answer = reading ? result : (attempt.rawAnswers?.[id] ?? result.answer);
    if (!answer?.trim()) continue;
    const { label, page } = info.labels?.[id] || { label: reading ? 'Q' + id : id, page: null };
    const after = page ? info.source + ':' + page : null;
    if (!groups.has(after)) groups.set(after, []);
    groups.get(after).push({ label, text: answer });
  }
  const width = 1240,
    height = 1754,
    margin = 88,
    lineHeight = 46;
  const canvas = canvasOf(width, height),
    ctx = canvas.getContext('2d');
  try {
    for (const [after, answers] of groups) {
      let y;
      function header() {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#24241f';
        ctx.font = 'bold 39px sans-serif';
        const title = reading
          ? 'Paper 1 · Part ' + info.part
          : 'Paper 3 · Part ' + info.part + ' · Task ' + info.task;
        ctx.fillText(title, margin, 104);
        ctx.font = '27px sans-serif';
        ctx.fillText('打字答案', margin, 160);
        y = 243;
      }
      async function line(text, bold) {
        if (y > height - margin) {
          await onPage(await jpg(canvas), after);
          header();
        }
        ctx.font = (bold ? 'bold ' : '') + '30px sans-serif';
        ctx.fillText(text, margin, y);
        y += lineHeight;
      }
      header();
      for (const { label, text } of answers) {
        await line(label, true);
        ctx.font = '30px sans-serif';
        for (const paragraph of text.split(/\r\n?|\n/)) {
          let row = '';
          for (const token of paragraph.match(/\s+|[^\s]+/gu) || []) {
            if (row && ctx.measureText(row + token).width > width - 2 * margin) {
              await line(row);
              row = '';
            }
            for (const char of token) {
              if (row && ctx.measureText(row + char).width > width - 2 * margin) {
                await line(row);
                row = '';
              }
              row += char;
            }
          }
          await line(row);
        }
        y += 23;
      }
      await onPage(await jpg(canvas), after);
    }
  } finally {
    canvas.width = canvas.height = 1;
  }
}
