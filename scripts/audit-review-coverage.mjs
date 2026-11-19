import fs from 'node:fs/promises';
const root = new URL('../web/papers/', import.meta.url);
const catalogue = JSON.parse(await fs.readFile(new URL('practice-catalogue.json', root)));
const sources = JSON.parse(await fs.readFile(new URL('catalogue.json', root)));
const rows = [];
for (const entry of catalogue.lessons.filter((e) => ['A', 'B1'].includes(e.part))) {
  const row = {
    id: entry.id,
    year: entry.year,
    variant: entry.variant,
    part: entry.part,
    task: entry.task,
    playable: !entry.missingAudio,
  };
  if (!row.playable) {
    rows.push({ ...row, status: 'audio-unavailable', reason: entry.sourceNote });
    continue;
  }
  const l = JSON.parse(await fs.readFile(new URL(`practice/${entry.id}.json`, root)));
  const questions = l.questions.map((q) => ({
    id: q.id,
    number: q.number,
    textReference: !!q.referenceAnswer || (q.grading === 'verified' && q.answers.length > 0),
    scoringPoints: q.scoringPoints?.length || 0,
    audioPoints: (q.scoringPoints || []).filter((p) => p.sourceLabel.includes('原音')).length,
    contextualAudioPoints: (q.scoringPoints || []).filter(
      (p) =>
        p.sourceLabel.includes('原音') &&
        p.evidence?.every((e) => Number.isFinite(e.contextStart)) &&
        p.evidence.length,
    ).length,
    evidenceCount: q.evidence?.length || 0,
    contextualEvidence: (q.evidence || []).filter((e) => Number.isFinite(e.contextStart)).length,
    referencePage: !!sources.sources.find((s) => s.id === q.reference?.sourceId)?.pages[
      q.reference?.page - 1
    ],
    placeholderPrompt: /请按原题页/.test(q.prompt),
    autoGraded: q.grading !== 'self',
  }));
  rows.push({
    ...row,
    questions,
    questionCount: questions.length,
    references: questions.filter((q) => q.textReference).length,
    allReferences: questions.every((q) => q.textReference),
    allEvidence: questions.every((q) => q.evidenceCount > 0),
    referencePages: l.paper.referencePages,
  });
}
const playable = rows.filter((r) => r.playable);
const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    entries: rows.length,
    playable: playable.length,
    fullyTextReferencedTasks: playable.filter((r) => r.allReferences).length,
    aQuestions: playable.filter((r) => r.part === 'A').reduce((n, r) => n + r.questionCount, 0),
    aQuestionsWithContext: playable
      .filter((r) => r.part === 'A')
      .flatMap((r) => r.questions)
      .filter((q) => q.contextualEvidence > 0).length,
    b1ScoringPoints: playable.flatMap((r) => r.questions).reduce((n, q) => n + q.scoringPoints, 0),
    b1AudioPoints: playable.flatMap((r) => r.questions).reduce((n, q) => n + q.audioPoints, 0),
    b1AudioPointsWithContext: playable
      .flatMap((r) => r.questions)
      .reduce((n, q) => n + q.contextualAudioPoints, 0),
    b1Tasks: playable.filter((r) => r.part === 'B1').length,
    b1TasksWithScoringPoints: playable.filter(
      (r) => r.part === 'B1' && r.questions.some((q) => q.scoringPoints),
    ).length,
    questions: playable.reduce((n, r) => n + r.questionCount, 0),
    referenceAnswers: playable.reduce((n, r) => n + r.references, 0),
  },
  interpretation:
    'Actual item-level display coverage, not a claim of complete grading, full audio listening, or release approval.',
  rows,
};
const destination = process.argv[2] || '.local/verification/release-repair-2026-11-17/coverage.json';
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
