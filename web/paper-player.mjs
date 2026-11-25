import { locateChunk } from './paper-core.mjs';
import { RecordingSource } from './recording-source.mjs';

export class PaperPlayer {
  constructor(audio, notify = () => {}) {
    this.audio = audio;
    this.recording = new RecordingSource(audio);
    this.notify = notify;
    this.generation = 0;
    this.index = -1;
    this.time = 0;
    this.loading = false;
    this.playing = false;
    this.range = null;
    this.frame = null;
    audio.addEventListener('timeupdate', () => this.tick());
    audio.addEventListener('play', () => {
      this.playing = true;
      this.startClock();
      this.emit();
    });
    audio.addEventListener('pause', () => {
      cancelAnimationFrame(this.frame);
      this.frame = null;
      if (!this.loading) this.playing = false;
      this.emit();
    });
    audio.addEventListener('ended', () => this.ended());
    audio.addEventListener('error', () => {
      if (!this.loading && this.source) this.fail('录音未能播放，请重试。');
    });
  }
  startClock() {
    if (this.frame !== null) return;
    const next = () => {
      this.frame = null;
      if (this.audio.paused) return;
      this.tick();
      if (!this.audio.paused) this.frame = requestAnimationFrame(next);
    };
    this.frame = requestAnimationFrame(next);
  }
  emit(error = '') {
    this.notify({
      time: this.time,
      duration: this.source?.duration || 0,
      loading: this.loading,
      playing: this.playing,
      range: this.range,
      error,
    });
  }
  fail(error) {
    this.index = -1;
    this.loading = false;
    this.playing = false;
    this.emit(error);
  }
  cancel() {
    ++this.generation;
    this.controller?.abort();
    this.loading = false;
    this.audio.pause();
    this.playing = false;
    this.emit();
  }
  setSource(source) {
    this.cancel();
    this.recording.clear();
    this.index = -1;
    this.source = source;
    this.time = 0;
    this.range = null;
    this.emit();
  }
  async seek(requested, resume = this.playing, keepRange = false) {
    if (!this.source) return;
    if (!keepRange) this.range = null;
    const position = locateChunk(this.source.chunks, requested);
    const request = ++this.generation;
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.loading = true;
    this.audio.pause();
    this.playing = resume;
    this.time = position.time;
    this.emit();
    try {
      if (position.index !== this.index || !this.audio.src || this.audio.error) {
        this.index = -1;
        await this.recording.ready(this.source.chunks[position.index].src, controller.signal);
        if (request !== this.generation) return;
        this.index = position.index;
      }
      const offset = Math.min(position.offset, this.audio.duration || position.offset);
      await this.recording.seek(offset, controller.signal);
      if (request !== this.generation) return;
      this.loading = false;
      if (resume) await this.audio.play();
      this.playing = !this.audio.paused;
      this.emit();
    } catch (error) {
      if (request !== this.generation || error.name === 'AbortError') return;
      this.fail(error.name === 'NotAllowedError' ? '录音已就绪，请再点播放。' : error.message);
    }
  }
  toggle() {
    if (this.playing || this.loading) {
      this.cancel();
      return;
    }
    let time = this.time;
    if (this.range && (time < this.range.start || time >= this.range.end - 0.03)) time = this.range.start;
    else if (time >= (this.source?.duration || Infinity) - 0.03) time = 0;
    return this.seek(time, true, true);
  }
  playRange(start, end, loop = false) {
    if (
      !this.source ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > this.source.duration + 0.1
    )
      return;
    this.range = { start, end: Math.min(end, this.source.duration), loop };
    return this.seek(start, true, true);
  }
  tick() {
    if (this.loading || this.index < 0 || !this.source) return;
    this.time = this.source.chunks[this.index].start + this.audio.currentTime;
    if (this.range && this.time >= this.range.end - 0.025) {
      const range = this.range;
      if (range.loop && this.playing) {
        this.seek(range.start, true, true);
        return;
      }
      this.audio.pause();
      this.time = range.end;
      const endOffset = Math.min(this.audio.duration, range.end - this.source.chunks[this.index].start);
      if (Math.abs(this.audio.currentTime - endOffset) > 0.03) this.audio.currentTime = endOffset;
    }
    this.emit();
  }
  ended() {
    if (this.loading || !this.source) return;
    if (this.range && this.time >= this.range.end - 0.2) {
      if (this.range.loop) this.seek(this.range.start, true, true);
      else {
        this.playing = false;
        this.emit();
      }
    } else if (this.index + 1 < this.source.chunks.length)
      this.seek(this.source.chunks[this.index + 1].start, true, true);
    else {
      this.time = this.source.duration;
      this.playing = false;
      this.emit();
    }
  }
}
