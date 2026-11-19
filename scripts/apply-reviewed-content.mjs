import fs from 'node:fs/promises';
import { applyReviewedContent } from '../web/paper-reviewed-content.mjs';
import { validateLesson } from '../web/core.mjs';
const directory = new URL('../web/papers/', import.meta.url);
const reviewed = new Map();
for (const file of await fs.readdir(new URL('reviewed/', directory))) {
  if (!file.endsWith('.json')) continue;
  const data = JSON.parse(await fs.readFile(new URL(`reviewed/${file}`, directory)));
  reviewed.set(data.sessionId, data);
}
let count = 0;
const sessionPatches = new Map();
for (const file of await fs.readdir(new URL('practice/', directory))) {
  if (!file.endsWith('.json')) continue;
  const path = new URL(`practice/${file}`, directory);
  const lesson = JSON.parse(await fs.readFile(path));
  const review = reviewed.get(lesson.paper.sessionId);
  if (!review?.tasks[`${lesson.paper.part}-${lesson.paper.task}`]) continue;
  applyReviewedContent(lesson, review);
  const corrections = review.tasks[`${lesson.paper.part}-${lesson.paper.task}`].sentences || [];
  if (corrections.length) {
    const sessionPath = new URL(`sessions/${lesson.paper.sessionId}.json`, directory);
    const session = sessionPatches.get(sessionPath.href) || JSON.parse(await fs.readFile(sessionPath));
    const offset = lesson.paper.originalAudioRange.start;
    for (const correction of corrections) {
      const s = structuredClone(correction);
      s.start += offset;
      s.end += offset;
      s.words = s.words.map((w) => ({
        ...w,
        ...(w.start === null ? {} : { start: w.start + offset, end: w.end + offset }),
      }));
      session.sentences = session.sentences.filter((original) => original.id !== s.id);
      session.sentences.push(s);
    }
    session.sentences.sort((a, b) => a.start - b.start);
    sessionPatches.set(sessionPath.href, session);
  }
  validateLesson(lesson);
  await fs.writeFile(path, JSON.stringify(lesson) + '\n');
  count++;
}
for (const [path, session] of sessionPatches)
  await fs.writeFile(new URL(path), JSON.stringify(session, null, 2) + '\n');
console.log(`Applied reviewed content to ${count} Tasks. Grading unchanged.`);
