let catalog, catalogRequest;
export function loadBooks() {
  return (catalogRequest ||= fetch('./papers/answer-books.json')
    .then(async (r) => {
      if (!r.ok) throw Error('答题册页表未载入。');
      return (catalog = await r.json());
    })
    .catch((e) => {
      catalogRequest = null;
      throw e;
    }));
}
export const bookFor = (p) => catalog?.[p.sessionId + '-' + p.part];

// The editable answer stays separate from the review marks rendered on its saved page image.
export function bookPageEdits(prior, record, touched, originals) {
  const last = record.attempts.at(-1);
  const previous = prior?.records?.[record.lessonId]?.attempts.at(-1);
  const records = { ...prior?.records, [record.lessonId]: record };
  const answers = new Set(touched);
  const keys = new Set([
    ...answers,
    ...Object.keys(last.reviewInk || {}),
    ...Object.keys(previous?.reviewInk || {}),
  ]);
  function marks(records, page) {
    return Object.values(records || {}).flatMap((r) => {
      const attempt = r.attempts.at(-1);
      const version = attempt.sourceVersions?.[page.key];
      return version === page.originalHash ? attempt.reviewInk?.[page.key] || [] : [];
    });
  }
  return originals
    .filter((page) => !page.attachment && keys.has(page.key))
    .map((page) => {
      const key = page.key;
      const oldAnswer = prior?.ink?.[key] || [];
      const answer = answers.has(key) ? last.ink?.[key] || [] : oldAnswer;
      const strokes = [...answer, ...marks(records, page)];
      const reusable =
        prior?.pictures?.[key] &&
        JSON.stringify(strokes) === JSON.stringify([...oldAnswer, ...marks(prior.records, page)]);
      return { key, page, answer, strokes, reusable };
    });
}
