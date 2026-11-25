let request;

export function loadPaperCatalogue() {
  return (request ||= fetch('./papers/catalogue.json')
    .then((response) => {
      if (!response.ok) throw Error('原卷目录未能载入，请重试。');
      return response.json();
    })
    .catch((error) => {
      request = null;
      throw error;
    }));
}
