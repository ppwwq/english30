import { mountPaperStudy } from './paper-study.mjs';
import { practiceDrillContext, questionDrillSentence } from './focused-drill-core.mjs';

export function mountFocusedDrill({ play, cancel, onChange, requestSave }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'focused-drill-dialog';
  dialog.className = 'focused-drill-dialog panel';
  dialog.setAttribute('aria-labelledby', 'focused-drill-title');
  dialog.innerHTML = `<header class="focused-drill-heading"><div><p class="fine-print" id="focused-drill-context"></p><h2 id="focused-drill-title">练这一处</h2></div><button type="button" id="focused-drill-return" class="button-secondary">返回原题</button></header><p id="focused-drill-question"></p><p class="fine-print">已看过本题复盘，本次属于辅助练习；关提示再测只检验当场修正。</p><div id="focused-drill-host"></div><footer class="focused-drill-footer"><p>完成后回原题，确认这句话提供了什么信息。</p><button type="button" class="button-primary" id="focused-drill-save">保存本次学习纪录</button></footer>`;
  document.body.append(dialog);
  let offset = 0,
    lessonId = null,
    returnTarget = null;
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
    conceal: () => cancel(),
    onChange,
  });
  function close() {
    dialog.close();
  }
  dialog.querySelector('#focused-drill-return').onclick = close;
  dialog.querySelector('#focused-drill-save').onclick = () => requestSave();
  dialog.addEventListener('close', () => {
    cancel();
    study.suspend();
    delete document.body.dataset.focusedDrill;
    if (returnTarget?.isConnected) {
      returnTarget.scrollIntoView({ block: 'center' });
      returnTarget.focus({ preventScroll: true });
    }
    onChange();
  });
  return {
    open(lesson, question, target) {
      const sentenceId = questionDrillSentence(lesson, question);
      if (!sentenceId) return false;
      const context = practiceDrillContext(lesson);
      offset = context.offset;
      if (lessonId !== lesson.id) {
        study.setContext(context.session, context.selection);
        lessonId = lesson.id;
      }
      returnTarget = target;
      dialog.querySelector('#focused-drill-context').textContent = lesson.title;
      dialog.querySelector('#focused-drill-question').textContent =
        `${question.label || question.number}. ${question.prompt}`;
      cancel();
      document.body.dataset.focusedDrill = 'true';
      dialog.showModal();
      study.open(sentenceId, { retest: false });
      return true;
    },
    getSaveState: () => study.getSaveState(),
    suspend() {
      if (dialog.open) dialog.close();
    },
  };
}
