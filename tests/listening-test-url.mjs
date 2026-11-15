// Existing focused-player suites exercise the explicitly labelled 精练 mode.
export function listeningPracticeURL() {
  const url = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173/');
  url.hash = 'listening/practice';
  return url.href;
}
