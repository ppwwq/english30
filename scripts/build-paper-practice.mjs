import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, stat, rename, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPaperPractice,
  paperPracticeEntry,
  missingAudioPracticeEntries,
  planPaperAudio,
} from '../web/paper-practice-adapter.mjs';
import { validateLesson } from '../web/core.mjs';

// Rebuild from the public original-paper assets. No OCR, network, or private source path is used.
// ffmpeg and ffprobe must be on PATH, or set FFMPEG / FFPROBE to their executable paths.
// --reuse-audio retains already generated clips only after checking their actual duration.
const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const tool = async (name, args) =>
  (
    await execute(process.env[name.toUpperCase()] || name, args, {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const probe = async (path) =>
  JSON.parse(
    await tool('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,sample_rate,channels,bit_rate:format=duration,size',
      '-of',
      'json',
      path,
    ]),
  );
async function audioMetadata(path, measurement) {
  const stream = measurement.streams[0];
  if (stream.codec_name !== 'mp3') throw new Error(`${path}: expected an MP3 audio stream.`);
  return {
    duration: Number(measurement.format.duration),
    bytes: Number(measurement.format.size),
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    bitRate: Number(stream.bit_rate),
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  };
}
function webPath(path) {
  const absolute = resolve(web, path);
  if (!absolute.startsWith(`${web}${sep}`)) throw new Error('Asset path must remain inside web/.');
  return absolute;
}

async function renderAudio(cut) {
  const output = webPath(cut.audio);
  const durationMatches = (duration) =>
    Number.isFinite(duration) && Math.abs(duration - cut.duration) <= 0.15;
  if (process.argv.includes('--reuse-audio')) {
    try {
      const existing = await probe(output);
      const duration = Number(existing.format.duration);
      if (durationMatches(duration)) return { ...(await audioMetadata(output, existing)), reused: true };
    } catch {
      /* Missing clips are generated below. */
    }
  }
  const inputs = cut.chunks.map((chunk) => webPath(chunk.src));
  await Promise.all(inputs.map((path) => stat(path)));
  const original = await probe(inputs[0]);
  const stream = original.streams[0];
  const scratch = await mkdtemp(join(tmpdir(), 'english30-paper-practice-'));
  const list = join(scratch, 'input.ffconcat');
  const temporary = `${output}.tmp.mp3`;
  try {
    const lines = cut.chunks.map((chunk, index) => {
      const escaped = inputs[index].replaceAll('\\', '/').replaceAll("'", "'\\''");
      return `file '${escaped}'\nduration ${chunk.duration}`;
    });
    await writeFile(list, `ffconcat version 1.0\n${lines.join('\n')}\n`, 'utf8');
    await tool('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-ss',
      String(cut.startOffset),
      '-t',
      String(cut.duration),
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${Math.round(Number(stream.bit_rate || 48000) / 1000)}k`,
      '-ar',
      String(stream.sample_rate),
      '-ac',
      String(stream.channels),
      '-write_xing',
      '1',
      temporary,
    ]);
    const result = await probe(temporary);
    const duration = Number(result.format.duration);
    if (!durationMatches(duration))
      throw new Error(`${cut.audio}: expected ${cut.duration}s, got ${duration}s.`);
    await rename(temporary, output);
    return { ...(await audioMetadata(output, result)), reused: false };
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await unlink(list).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(scratch);
  }
}

const catalogue = await json(join(web, 'papers', 'catalogue.json'));
const focused = await json(join(web, 'lesson-catalogue.json'));
const verifiedLessons = await Promise.all(focused.lessons.map((entry) => json(webPath(entry.url))));
await mkdir(join(web, 'audio'), { recursive: true });
await mkdir(join(web, 'papers', 'practice'), { recursive: true });
const entries = [];
const audio = new Map();
let audioBytes = 0;
const priority = (session) =>
  session.year === 2025 ? 0 : session.year === 2023 ? 1 : session.year === 2012 ? 2 : 3;
const sessions = [...catalogue.sessions].sort(
  (a, b) => priority(a) - priority(b) || b.year - a.year || a.id.localeCompare(b.id),
);
for (const metadata of sessions) {
  const session = await json(webPath(metadata.url));
  for (const task of session.tasks) {
    const cut = planPaperAudio(session, task);
    let output = audio.get(cut.audio);
    if (
      output &&
      (output.sourceRange.start !== cut.range.start || output.sourceRange.end !== cut.range.end)
    ) {
      throw new Error(`${cut.audio}: shared Part B tasks have inconsistent source ranges.`);
    }
    if (!output) {
      output = { ...(await renderAudio(cut)), sourceRange: cut.range, sourceChunks: cut.chunks };
      audio.set(cut.audio, output);
      audioBytes += output.bytes;
      console.log(
        `${audio.size}/75 ${cut.audio} ${output.duration.toFixed(3)}s${output.reused ? ' reused' : ''}`,
      );
    }
    const lesson = buildPaperPractice({
      session,
      task,
      catalogue,
      duration: output.duration,
      verifiedLessons,
    });
    validateLesson(lesson);
    const entry = paperPracticeEntry(lesson);
    await writeFile(webPath(entry.url), `${JSON.stringify(lesson)}\n`, 'utf8');
    entries.push(entry);
  }
  console.log(`Ready: ${session.id} (${session.tasks.length} Tasks)`);
}
entries.push(...missingAudioPracticeEntries(catalogue));
entries.sort((a, b) => b.year - a.year || a.variant.localeCompare(b.variant) || a.task - b.task);
const result = { schemaVersion: 1, lessons: entries };
await writeFile(
  join(web, 'papers', 'practice-audio.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      audio: [...audio].map(([src, { reused, ...measurement }]) => ({ src, ...measurement })),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
await writeFile(
  join(web, 'papers', 'practice-catalogue.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);
console.log(
  JSON.stringify({
    lessons: entries.filter((entry) => !entry.missingAudio).length,
    unavailable: entries.filter((entry) => entry.missingAudio).length,
    audioFiles: audio.size,
    audioBytes,
  }),
);
// Keep reviewed references and contextual evidence when regenerating audio/lessons.
await import('./apply-reviewed-content.mjs');
