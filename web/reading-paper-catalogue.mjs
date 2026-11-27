const parts = ['A', 'B1'];
const variantLabels = { exam: '正式卷', practice: 'Practice Paper', sample: 'Sample Paper' };

export function readingPaperSelection(taskId) {
  const match = /^reading-paper:(20\d{2})-(exam|sample|practice):(A|B1)$/.exec(taskId);
  if (!match) return null;
  const [, year, variant, part] = match;
  return { year: Number(year), variant, part };
}

export function readingPaperTitle({ year, variant, part }) {
  return `${year} Paper 1 · ${variantLabels[variant]} · Part ${part}`;
}
const pageLabels = {
  text: '阅读文章',
  question: '答题册',
  reference: '评分参考',
};

// All page numbers are one-based positions in the existing original PDFs.
// A and B1 list their article pages first and their question-answer book pages second.
const standardA = { text: [2, 3], question: [4, 5, 6, 7] };
const standardB1 = { text: [9, 10], question: [11, 12, 13, 14] };
const standardSplit = { A: standardA, B1: standardA };

const editions = [
  {
    year: 2025,
    source: 'p-6ba7d95bdcc0',
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 21, B1: 42 },
    marking: { source: 'p-9f8236cfe333', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2024,
    source: { A: 'p-2bb0bc01488a', B1: 'p-99d5fda091a9' },
    paper: standardSplit,
    lastQuestion: { A: 23, B1: 42 },
    marking: { source: 'p-f3aeb809c6bf', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2023,
    source: 'p-8b9f11b3b567',
    paper: {
      A: { text: [2, 3], question: [10, 11, 12, 13] },
      B1: { text: [5, 6], question: [14, 15, 16, 17] },
    },
    lastQuestion: { A: 22, B1: 45 },
    marking: { source: 'p-b9e018ef8208', A: [1], B1: [1, 2] },
  },
  {
    year: 2022,
    source: 'p-956807ac5e5a',
    paper: {
      A: { text: [1, 2], question: [3, 4, 5, 6] },
      // Page 11 is a cropped second copy of the question page on PDF page 12.
      B1: { text: [8, 9], question: [10, 12, 13, 14] },
    },
    lastQuestion: { A: 23, B1: 42 },
    marking: { source: 'p-bc0abeb1a37a', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2021,
    source: 'p-8d6c5b657b76',
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 27, B1: 46 },
    marking: { source: 'p-cd2535dfcb2b', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2020,
    source: 'p-c2a6c9ca9abc',
    // Use the first of the two scans of the B1 question-answer book.
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 19, B1: 41 },
    marking: { source: 'p-31204b432346', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2019,
    source: { A: 'p-12e64ade948d', B1: 'p-7eaaf2116dae' },
    paper: {
      A: standardA,
      // OCR in this file repeats text layers across adjacent pages. The scans are distinct.
      B1: { text: [2, 3], question: [4, 5, 6, 7, 8, 9] },
    },
    lastQuestion: { A: 18, B1: 41 },
    marking: { source: 'p-b9ef39280902', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2018,
    source: 'p-d379f96208ba',
    paper: {
      A: { text: [1, 2], question: [3, 4, 5, 6, 7, 8] },
      B1: { text: [10, 11], question: [12, 13, 14, 15] },
    },
    lastQuestion: { A: 22, B1: 45 },
    marking: { source: 'p-3dc72dea616b', A: [1], B1: [1, 2], rotation: 90 },
  },
  {
    year: 2017,
    source: 'p-4c8127f1b8f7',
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 21, B1: 44 },
    marking: { source: 'p-75f366107721', A: [1, 2, 3], B1: [3, 4] },
  },
  {
    year: 2016,
    source: 'p-ea5bc9174850',
    paper: {
      A: { text: [2, 3], question: [10, 11, 12, 13] },
      B1: { text: [5, 6], question: [14, 15, 16, 17] },
    },
    lastQuestion: { A: 18, B1: 46 },
    marking: { source: 'p-70f90dfea1e6', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2015,
    source: 'p-844b78372b58',
    paper: {
      A: { text: [6, 7], question: [1, 2, 3, 4] },
      B1: { text: [13, 14], question: [8, 9, 10, 11] },
    },
    lastQuestion: { A: 31, B1: 55 },
    marking: { source: 'p-7d51820b8786', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2014,
    source: 'p-c5688f4faa4d',
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 30, B1: 59 },
    marking: { source: 'p-7d3d91a4edab', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2013,
    source: { text: 'p-5cc25c61965c', question: 'p-962b3b805430' },
    paper: {
      A: { text: [1, 2], question: [1, 2, 3, 4] },
      B1: { text: [3, 4], question: [5, 6, 7, 8] },
    },
    lastQuestion: { A: 25, B1: 45 },
    marking: { source: 'p-8955fdbe2df3', A: [1, 2], B1: [2, 3, 4] },
  },
  {
    year: 2012,
    source: 'p-e1ec898d170e',
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 20, B1: 40 },
    marking: { source: 'p-9a35c61b2710', A: [1, 2], B1: [2, 3] },
  },
  {
    year: 2012,
    variant: 'practice',
    source: 'p-f9b27a58d3fe',
    paper: { A: standardA, B1: standardB1 },
    lastQuestion: { A: 23, B1: 50 },
    marking: { source: 'p-b2c036c38ec6', A: [3, 4], B1: [4, 5], provisional: true },
  },
  {
    year: 2012,
    variant: 'sample',
    source: 'p-42e9b99dc3ec',
    paper: {
      A: { text: [17], question: [2, 3, 4, 5, 6, 7] },
      B1: { text: [18, 19], question: [8, 9, 10, 11] },
    },
    lastQuestion: { A: 38, B1: 56 },
    marking: { source: 'p-5b94ac0c839f', A: [1, 2], B1: [3, 4], separate: true },
  },
];

function readPages(source, numbers, kind, rotation) {
  const pages = [];
  for (const page of numbers) {
    const original = source?.pages?.[page - 1];
    if (!original?.src) return [];
    pages.push({
      ...original,
      id: `${source.id}:${page}`,
      sourceId: source.id,
      page,
      label: `${pageLabels[kind]} · 来源第 ${page} 页`,
      kind,
      ...(rotation ? { rotation } : {}),
    });
  }
  return pages;
}

function practicePages(source, numbers, kind, year, variant, part) {
  if (
    source?.year !== year ||
    source.variant !== variant ||
    source.paper !== 1 ||
    source.role !== 'question' ||
    !source.parts?.includes(part)
  ) {
    return [];
  }
  if (source.containsAnswers) {
    const start = source.answerStartsPage;
    if (!Number.isInteger(start) || numbers.some((page) => page >= start)) return [];
  }
  return readPages(source, numbers, kind);
}

function markingReferences(source, marking, part, year, variant) {
  if (source?.year !== year || source.variant !== variant || source.role !== 'marking') {
    return [];
  }
  const pages = readPages(source, marking[part], 'reference', marking.rotation);
  if (!pages.length) return [];
  const mixed = !marking.separate;
  const label = marking.provisional ? '暂定评分参考' : '评分参考';
  return [
    {
      sourceId: source.id,
      label: mixed ? `${label}（有同页的其他分部）` : label,
      mixed,
      pages,
    },
  ];
}

export function buildReadingPaperCatalogue(sources) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  return editions.flatMap(({ year, variant = 'exam', source, paper, lastQuestion, marking }) => {
    const entries = parts.flatMap((part) => {
      const pages = [];
      for (const [kind, numbers] of Object.entries(paper[part])) {
        const sourceId = typeof source === 'string' ? source : (source[part] ?? source[kind]);
        const group = practicePages(sourcesById.get(sourceId), numbers, kind, year, variant, part);
        if (!group.length) return [];
        pages.push(...group);
      }
      const first = part === 'A' ? 1 : lastQuestion.A + 1;
      return [
        {
          id: part,
          pages,
          questions: Array.from({ length: lastQuestion[part] - first + 1 }, (_, index) => ({
            number: first + index,
          })),
          references: markingReferences(sourcesById.get(marking.source), marking, part, year, variant),
        },
      ];
    });
    return entries.length ? [{ id: `reading-paper-${year}-${variant}`, year, variant, parts: entries }] : [];
  });
}
