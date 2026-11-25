const labels = {
  listening: '正在载入听力练习…',
  'listening/practice': '正在载入听力练习…',
  library: '正在载入原卷…',
  papers: '正在载入原卷…',
  reading: '正在载入阅读练习…',
  integrated: '正在载入 B1 综合练习…',
  writing: '正在载入写句练习…',
  account: '正在载入我的答卷…',
  review: '正在载入复习记录…',
  today: '正在载入训练计划…',
};

export function showViewLoading(view) {
  const notice = document.getElementById('view-loading');
  notice.textContent = labels[view] || '';
  notice.hidden = !notice.textContent;
}
