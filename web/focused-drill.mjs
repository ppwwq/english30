import { mountPaperStudy } from './paper-study.mjs';
import {
  practiceDrillContext,
  questionDrillSentence,
  sentenceQuestionLabels,
} from './focused-drill-core.mjs';

export function mountFocusedDrill({ play, cancel, onChange }) {
  const dialog = document.createElement('section');
  dialog.id = 'focused-drill-dialog';
  dialog.className = 'focused-drill-dialog panel';
  dialog.hidden = true;
  dialog.setAttribute('aria-labelledby', 'focused-drill-title');
  dialog.innerHTML = `<header class="focused-drill-heading"><div><p class="fine-print" id="focused-drill-context"></p><h2 id="focused-drill-title">练这一处</h2></div><button type="button" id="focused-drill-return" class="button-secondary">返回原题</button></header><p id="focused-drill-question"></p><p class="fine-print">已看过本题复盘，本次属于辅助练习；关提示再测只检验当场修正。</p><div id="focused-drill-host"></div><footer class="focused-drill-footer"><p>完成后回原题，确认这句话提供了什么信息。</p></footer>`;
  document.body.append(dialog);
  let labelsBySentence = new Map(),
    openingSentenceId = null,
    questionText = '',
    offset = 0,
    lessonId = null,
    returnTarget = null;
  const concealed = new Map();
  function concealHints() {
    const hints = document.querySelectorAll(
      '.transcript-panel, #word-inspector, #practice-sources, #review-navigation, #open-marking-page, #paper-float-transcript, #open-review-marks',
    );
    const hide = (node) => {
      if (!concealed.has(node)) concealed.set(node, node.hidden);
      node.hidden = true;
    };
    for (const node of hints) hide(node);
    for (const id of ['questions', 'original-responses']) {
      const region = document.getElementById(id);
      if (region.contains(dialog)) {
        for (let child = dialog; child !== region; child = child.parentElement) {
          for (const sibling of child.parentElement.children) if (sibling !== child) hide(sibling);
        }
      } else hide(region);
    }
  }
  const study = mountPaperStudy({
    host: dialog.querySelector('#focused-drill-host'),
    idPrefix: 'focus-',
    play: (sentence) => play(sentence.start - offset, sentence.end - offset),
    formatTime: (seconds) => {
      const relative = Math.max(0, seconds - offset);
      return `${Math.floor(relative / 60)}:${String(Math.floor(relative % 60)).padStart(2, '0')}（本 Task）`;
    },
    cancel,
    isExposed: () => true,
    conceal: concealHints,
    onChange,
    onSentenceChange: (sentence) => {
      dialog.querySelector('#focused-drill-title').textContent = sentence
        ? `单句听写 · ${Math.floor((sentence.start - offset) / 60)}:${String(Math.floor((sentence.start - offset) % 60)).padStart(2, '0')}`
        : '单句听写';
      const labels = labelsBySentence.get(sentence?.id) || [];
      dialog.querySelector('#focused-drill-question').textContent =
        labels.join('、') + (sentence?.id === openingSentenceId ? ' · ' + questionText : '');
    },
  });
  function close(restoreFocus) {
    dialog.hidden = true;
    study.suspend();
    cancel();
    document.body.append(dialog);
    for (const [node, wasHidden] of concealed) node.hidden = wasHidden;
    concealed.clear();
    delete document.body.dataset.focusedDrill;
    if (restoreFocus && returnTarget?.isConnected) {
      returnTarget.scrollIntoView({ block: 'center' });
      returnTarget.focus({ preventScroll: true });
    }
    returnTarget = null;
    onChange();
  }
  dialog.querySelector('#focused-drill-return').onclick = () => close(true);
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
    }
  });
  return {
    open(lesson, question, target) {
      const sentenceId = questionDrillSentence(lesson, question);
      if (!sentenceId) return false;
      if (!dialog.hidden) close(false);
      const context = practiceDrillContext(lesson);
      offset = context.offset;
      openingSentenceId = sentenceId;
      questionText = question.prompt;
      if (lessonId !== lesson.id) {
        labelsBySentence = new Map(
          lesson.sentences.map((s) => [s.id, sentenceQuestionLabels(lesson.questions, s.start, s.end)]),
        );
        context.session.sentences = context.session.sentences.filter(
          (s) => labelsBySentence.get(s.id).length,
        );
        study.setContext(context.session, context.selection);
        lessonId = lesson.id;
      }
      returnTarget = target;
      dialog.querySelector('#focused-drill-context').textContent = lesson.title;
      cancel();
      document.body.dataset.focusedDrill = 'true';
      const original = document.getElementById(`answer-${question.id}`)?.closest('.original-response');
      (original?.getClientRects().length ? original : target.closest('.question-card')).append(dialog);
      dialog.hidden = false;
      study.open(sentenceId, { retest: false });
      const back = dialog.querySelector('#focused-drill-return');
      back.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      back.focus({ preventScroll: true });
      return true;
    },
    getSaveState: () => study.getSaveState(),
    suspend() {
      if (!dialog.hidden) close(false);
    },
  };
}
