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
