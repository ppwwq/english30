import { confirmAction } from './confirmation.mjs';

export async function confirmAccountSave({ name, items, job, combinedAvailable }) {
  const identity = document.createElement('p');
  identity.textContent = '当前账号 · ' + name;
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  const size = document.createElement('p');
  const reading = job.readingPapers || [];
  const strokes =
    (job.paper?.touched.length || 0) +
    reading.reduce((total, { record }) => {
      const { inkFiles, reviewInkFiles } = record.details.readingPaper;
      return total + new Set([...Object.keys(inkFiles || {}), ...Object.keys(reviewInkFiles || {})]).size;
    }, 0);
  const typed =
    Object.values(job.paper?.record.attempts.at(-1)?.results || {}).some((r) => r.answer?.trim()) ||
    reading.some(({ record }) => Object.values(record.answers).some((answer) => answer.trim()));
  const metadata = new Blob([JSON.stringify(job.delta)]).size;
  size.textContent =
    job.paper || reading.length
      ? '本次涉及 ' + strokes + ' 个手写页' + (typed ? '及打字答案附页' : '') + '。整页按原图尺寸保存。'
      : '本次保存已提交的学习记录。';
  const bytes = metadata + (strokes + (typed ? 1 : 0)) * 450000;
  const estimate =
    bytes < 1024 * 1024
      ? Math.max(1, Math.round(bytes / 1024)) + ' KB'
      : (bytes / 1024 / 1024).toFixed(1) + ' MB';
  size.textContent += ' 预计上传约 ' + estimate + '。';
  const combined = document.createElement('input');
  combined.type = 'checkbox';
  const choice = document.createElement('label');
  choice.hidden = !combinedAvailable;
  choice.append(combined, ' 将同年 Part A 和 B1 合为一份答卷');
  const attach = document.createElement('input');
  attach.type = 'checkbox';
  const dataLabel = document.createElement('label');
  dataLabel.append(attach, ' 附上本年的 B1 Data File');
  function showData() {
    dataLabel.hidden = !(
      combinedAvailable &&
      job.paper?.hasSeparateData &&
      (combined.checked || job.paper.info.part === 'B1')
    );
    if (dataLabel.hidden) attach.checked = false;
  }
  combined.onchange = showData;
  showData();
  const foot = document.createElement('p');
  foot.textContent = '确认后先写入本机，再上传并核对。未提交的输入仍留在草稿中。';
  const accepted = await confirmAction(
    '保存到我的账号',
    [identity, list, size, choice, dataLabel, foot],
    '确认保存',
  );
  return accepted ? { combined: combined.checked, includeData: attach.checked } : null;
}
