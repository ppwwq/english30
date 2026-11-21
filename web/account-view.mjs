const phases = {
  first: '首次作答',
  independent: '首次作答',
  assisted: '辅助练习',
  retest: '复测',
  'assisted-first': '辅助首答',
  'independent-first': '独立首答',
};
const authLabels = { login: '登录', register: '注册账号', recover: '找回账号' };
const dateFormat = new Intl.DateTimeFormat('zh-HK', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function savedDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? dateFormat.format(date) : '';
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}
function button(label, action, style = 'button-secondary') {
  const control = node('button', style, label);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}
function link(label, href, style) {
  const control = node('a', style, label);
  control.href = href;
  return control;
}
function field(label, input) {
  const group = node('label', 'account-field');
  input.setAttribute('aria-label', label);
  group.append(node('span', '', label), input);
  return group;
}
function input(name, type, autocomplete) {
  const control = node('input');
  Object.assign(control, { name, type, autocomplete, required: true });
  if (type === 'text') {
    control.autocapitalize = 'none';
    control.spellcheck = false;
  }
  return control;
}
function selector(options, value, onChange) {
  const select = node('select');
  for (const [id, title] of options) select.add(new Option(title, id));
  select.value = String(value);
  select.addEventListener('change', () => onChange(select.value));
  return select;
}
function heading(text, level = 'h2') {
  const h = node(level, '', text);
  h.tabIndex = -1;
  return h;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', new URL('./ink-icons.svg#' + name, import.meta.url).href);
  svg.append(use);
  return svg;
}
function optionsFrom(values, allLabel) {
  return [['', allLabel], ...values.map((value) => [value, value])];
}
function missingPage(page) {
  return page.missing || page.kind === 'missing';
}
function paperMeta(paper) {
  const tasks = Array.isArray(paper.tasks) ? paper.tasks.filter(Boolean).map(String) : [];
  return [
    phases[paper.phase] || paper.phase,
    tasks.length ? tasks.map((task) => (/^\d+$/.test(task) ? 'Task ' + task : task)).join('、') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function mountAccountView(root, controller) {
  root.classList.add('account-host');
  const mast = node('header', 'account-heading');
  const title = heading('我的答卷', 'h1');
  const identity = node('p');
  mast.append(title, identity);
  const notices = node('div', 'account-notices');
  const status = node('p', 'account-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const content = node('div', 'account-content');
  const settings = node('div');
  root.replaceChildren(mast, notices, status, content, settings);

  let owner,
    mode = 'login',
    year = '',
    part = '',
    busy = false,
    destroyed = false,
    request = 0;
  let papers = [],
    active = null,
    recovery = null,
    conflict = null,
    queuedRefresh = false;
  const receipt = controller.takeRecoveryCode?.();
  if (receipt) recovery = { owner: controller.state().user?.id, code: receipt };
  let guestTotal = 0,
    guestIssue = '';
  const valid = (seq, id) => !destroyed && seq === request && id === controller.state().user?.id;
  function say(message = '', error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }
  const note = (text) => node('p', 'account-note', text);
  const actions = (...controls) => {
    const box = node('div', 'account-actions');
    box.append(...controls);
    return box;
  };
  const focus = (element) => {
    if (!element || root.hidden) return;
    if (busy)
      requestAnimationFrame(() => {
        if (element.isConnected && !root.hidden) element.focus({ preventScroll: true });
      });
    else element.focus({ preventScroll: true });
  };
  function changeMode(nextMode) {
    const name = content.querySelector('input[name="username"]')?.value || '';
    mode = nextMode;
    say();
    renderAuth(name);
    focus(content.querySelector('.account-auth h1'));
  }
  function renderAuth(name = '') {
    root.dataset.screen = 'access';
    mast.hidden = true;
    const form = node('form', 'account-auth');
    const user = input('username', 'text', 'username');
    user.value = name;
    const password = input('password', 'password', mode === 'login' ? 'current-password' : 'new-password');
    const code = input('recoveryCode', 'text', 'off');
    const userField = field('用户名', user);
    if (mode === 'register') {
      const rules = note('3–32 个字，可用汉字、字母、数字、点、短横线或下划线。');
      rules.id = 'account-name-rules';
      user.setAttribute('aria-describedby', rules.id);
      userField.append(rules);
    }
    const intro = node('div', 'account-auth-intro');
    intro.append(heading(authLabels[mode], 'h1'), note('登录后，可在其他设备取回已保存的答卷和笔迹。'));
    form.append(intro, userField);
    if (mode === 'recover') form.append(field('恢复码', code));
    const passwordField = field(mode === 'recover' ? '新密码' : '密码', password);
    if (mode !== 'login') {
      password.minLength = 10;
      password.maxLength = 128;
      const rules = note('10–128 个字符。');
      rules.id = 'account-password-rules';
      password.setAttribute('aria-describedby', rules.id);
      passwordField.append(rules);
    }
    form.append(passwordField);
    const submitText = mode === 'recover' ? '重设密码并登录' : authLabels[mode];
    const submit = node('button', 'button-primary', submitText);
    submit.type = 'submit';
    const alternatives = actions(
      ...Object.keys(authLabels)
        .filter((item) => item !== mode)
        .map((item) =>
          button(item === 'login' ? '返回登录' : authLabels[item], () => changeMode(item), 'button-text'),
        ),
    );
    form.append(submit, alternatives);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const operation = mode;
      void perform('正在处理账号…', async () => {
        const result =
          operation === 'recover'
            ? await controller.recover(user.value.trim(), code.value.trim(), password.value)
            : await controller[operation](user.value.trim(), password.value);
        if (result?.recoveryCode)
          recovery = { owner: controller.state().user?.id, code: result.recoveryCode };
        await refresh();
        if (recovery) focus(notices.querySelector('h2'));
        else focus(title);
      });
    });
    const cover = node('aside', 'account-cover');
    const coverText = node('div', 'account-cover-caption');
    coverText.append(heading('我的答卷'), node('p', '', '2025 正式卷 / Paper 3 / Part A'));
    const sheet = node('img');
    // The public, blank question-book cover is independent of the signed-in user's papers.
    sheet.src = './papers/pages/p-e6f14047f00b/0001.webp';
    sheet.alt = '';
    sheet.addEventListener(
      'error',
      () => {
        cover.hidden = true;
      },
      { once: true },
    );
    cover.append(coverText, sheet);
    const access = node('div', 'account-access');
    access.append(form, cover);
    content.replaceChildren(access);
  }
  async function perform(label, task) {
    if (busy || destroyed) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    // Keep the live status available while preventing repeated writes and credential edits.
    for (const region of [notices, content, settings]) region.inert = true;
    say(label);
    let failed = false;
    try {
      await task();
      if (status.textContent === label) say();
    } catch (error) {
      failed = true;
      if (error.code === 'VERSION_CONFLICT') conflict = { paperId: error.paperId };
      renderNotices();
      say(error.message || '操作未完成，请重试。', true);
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
      for (const region of [notices, content, settings]) region.inert = false;
      if (queuedRefresh) {
        queuedRefresh = false;
        if (!failed || owner !== controller.state().user?.id) await refresh();
      }
    }
  }
  function renderNotices() {
    notices.replaceChildren();
    const state = controller.state();
    if (!state.user) return;
    if (recovery?.owner === state.user.id) {
      const block = node('section', 'account-callout');
      const code = node('code', 'account-recovery-code', recovery.code);
      const copy = button('复制恢复码', async () => {
        try {
          await navigator.clipboard.writeText(code.textContent);
          say('恢复码已复制。');
        } catch {
          const range = document.createRange();
          range.selectNodeContents(code);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          say('恢复码已选中，请长按或按复制快捷键。');
        }
      });
      block.append(
        heading('请收好恢复码'),
        note('忘记密码时，用这串恢复码找回账号。请先复制并保存，再关闭此提示。'),
        code,
        actions(
          copy,
          button(
            '我已保存恢复码',
            () => {
              recovery = null;
              renderNotices();
              say();
              focus(title);
            },
            'button-quiet',
          ),
        ),
      );
      notices.append(block);
    }
    const clash = state.conflict || conflict;
    if (!state.pending && !clash) return;
    const block = node('section', 'account-callout');
    const again = (asCopy) =>
      perform('正在上传已确认的保存…', async () => {
        if (asCopy) await controller.retry({ asCopy: true });
        else await controller.retry();
        conflict = null;
        await refresh();
      });
    if (clash) {
      const controls = actions(button('另存为独立答卷', () => again(true)));
      if (clash.paperId)
        controls.append(button('查看云端新版', () => openPaper(clash.paperId), 'button-quiet'));
      block.append(
        heading('这份答卷已有新版'),
        note('两台设备都修改了这份答卷。可将本机作答另存一份，保留两次修改。'),
        controls,
      );
    } else {
      block.append(
        heading('已存本机，云端待完成'),
        note('待上传的保存共有 ' + state.pending + ' 次。'),
        button('重试上传', () => again(false)),
      );
    }
    notices.append(block);
  }
  function renderSettings(user) {
    const menu = node('details', 'account-settings');
    const summary = node(
      'summary',
      '',
      guestTotal ? '账号与学习记录 · 可导入 ' + guestTotal + ' 条游客记录' : '账号与学习记录',
    );
    const body = node('div', 'account-settings-body');
    if (guestIssue) body.append(note('本机游客记录暂时无法导入。' + guestIssue));
    if (guestTotal > 0) {
      const section = node('section');
      section.append(
        heading('本机游客记录', 'h3'),
        note('这台设备有 ' + guestTotal + ' 条游客记录可导入。'),
        button('导入到我的账号', () => {
          if (!confirm('确认这 ' + guestTotal + ' 条游客记录属于你，并上传至账号「' + user.name + '」？'))
            return;
          void perform('正在导入游客记录…', async () => {
            await controller.importGuest();
            await refresh();
            say('已完成游客记录导入。');
          });
        }),
      );
      body.append(section);
    }
    const importFile = button(
      '从完整备份导入',
      () => {
        const picker = node('input');
        picker.type = 'file';
        picker.accept = '.json,application/json';
        picker.onchange = () => {
          const file = picker.files?.[0];
          if (!file) return;
          void perform('正在读取学习备份…', async () => {
            if (file.size > 32 * 1024 * 1024) throw Error('备份文件太大，无法一次导入。');
            const data = JSON.parse(await file.text());
            const { validateBackup } = await import('./training-core.mjs');
            const backup = validateBackup(data);
            const count = backup.listening.length + backup.study.records.length;
            if (
              !confirm(
                '将「' + file.name + '」中的 ' + count + ' 条作答及其复习记录导入账号「' + user.name + '」？',
              )
            )
              return;
            await controller.importBackup(backup);
            await refresh();
            say('已导入完整学习备份。');
          });
        };
        picker.click();
      },
      'button-quiet',
    );
    const records = node('section');
    records.append(
      heading('学习记录', 'h3'),
      note('在这台设备取回账号里已保存的学习记录。'),
      button('取回学习记录', () =>
        perform('正在取回学习记录…', async () => {
          const restored = await controller.restoreLearning();
          say(restored === false ? '这个账号暂时没有已保存的学习记录。' : '已取回学习记录。');
        }),
      ),
    );
    records.append(importFile);
    body.append(records);
    const exit = button('退出登录', () =>
      perform('正在退出…', async () => {
        await controller.logout();
        await refresh();
        focus(title);
      }),
    );
    const remove = node('details', 'account-delete');
    const deletion = node('form');
    const password = input('password', 'password', 'current-password');
    const submit = node('button', 'button-secondary account-danger', '永久删除账号');
    submit.type = 'submit';
    deletion.append(
      note('删除后，账号及其云端答卷和版本将无法取回。'),
      field('输入密码确认身份', password),
      submit,
    );
    deletion.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!confirm('永久删除「' + user.name + '」及其云端记录？')) return;
      void perform('正在删除账号…', async () => {
        await controller.deleteAccount(password.value);
        await refresh();
        say('账号已删除。');
        focus(title);
      });
    });
    remove.append(node('summary', '', '删除账号'), deletion);
    body.append(exit, remove);
    menu.append(summary, body);
    settings.replaceChildren(menu);
  }
  function renderList(returnId) {
    root.dataset.screen = 'library';
    active = null;
    mast.hidden = false;
    const library = node('section', 'account-library');
    const rows = node('ul', 'account-list');
    const noMatch = node('div', 'account-empty');
    const count = node('p', 'account-count');
    count.setAttribute('role', 'status');
    function filter() {
      rows.replaceChildren();
      const visible = papers.filter((p) => (!year || String(p.year) === year) && (!part || p.part === part));
      count.textContent = visible.length + ' 份答卷';
      noMatch.hidden = visible.length > 0;
      for (const p of visible) {
        const row = node('li');
        const open = button('', () => openPaper(p.id), 'account-paper');
        open.dataset.paperId = p.id;
        const label = node('span', 'account-paper-label');
        const yearPrefix = String(p.year) + ' ';
        const hasYearPrefix = p.title.startsWith(yearPrefix);
        const yearMark = hasYearPrefix ? node('span', 'account-paper-year', p.year) : icon('paper');
        label.append(
          node('strong', '', hasYearPrefix ? p.title.slice(yearPrefix.length) : p.title),
          node('small', '', paperMeta(p)),
        );
        const meta = node('span', 'account-paper-meta');
        meta.append(node('span', '', '版本 ' + p.version), node('small', '', savedDate(p.savedAt)));
        if (Number(p.missing) > 0 || p.missing === true)
          label.append(node('small', 'account-warning', '缺原页'));
        open.append(yearMark, label, meta, icon('next'));
        row.append(open);
        rows.append(row);
        if (returnId === p.id) queueMicrotask(() => focus(open));
      }
    }
    if (papers.length) {
      const years = [...new Set(papers.map((p) => String(p.year)))].sort((a, b) => b.localeCompare(a));
      const parts = [...new Set(papers.map((p) => p.part).filter(Boolean))].sort();
      if (!years.includes(year)) year = '';
      if (!parts.includes(part)) part = '';
      const filters = node('div', 'account-filters');
      filters.append(
        count,
        field(
          '年份',
          selector(optionsFrom(years, '全部年份'), year, (v) => {
            year = v;
            filter();
          }),
        ),
        field(
          'Part',
          selector(optionsFrom(parts, '全部 Part'), part, (v) => {
            part = v;
            filter();
          }),
        ),
      );
      library.append(filters);
      noMatch.append(
        heading('没有符合筛选的答卷'),
        button('清除筛选', () => {
          year = '';
          part = '';
          renderList();
          focus(content.querySelector('select'));
        }),
      );
    } else {
      noMatch.append(
        icon('paper'),
        heading('还没有云端答卷'),
        note('做完一个 Task 后，提交作答并确认保存，答卷就会出现在这里。'),
        link('去做一份听力原卷', '#listening', 'button-secondary'),
      );
    }
    filter();
    library.append(rows, noMatch);
    content.replaceChildren(library);
  }
  async function openPaper(id, version, restoreFocus = true) {
    const paper = papers.find((p) => p.id === id);
    if (!paper) {
      say('这份云端答卷暂时不可用。', true);
      return;
    }
    const seq = ++request,
      identity = owner;
    const v = Number(version || paper.version);
    const previousPage = active?.id === id ? active.page : null;
    const back = button(
      '返回答卷列表',
      () => {
        ++request;
        say();
        renderList(id);
      },
      'button-text account-back',
    );
    back.prepend(icon('prev'));
    content.replaceChildren(back, note('正在读取答卷…'));
    try {
      const [versions, detail] = await Promise.all([controller.versions(id), controller.detail(id, v)]);
      if (!valid(seq, identity)) return;
      active = { id, version: v, page: previousPage };
      const head = node('header', 'account-detail-heading');
      root.dataset.screen = 'detail';
      mast.hidden = true;
      const h = heading(paper.title, 'h1');
      const [exam, ...sections] = paper.title.split(' · ');
      if (sections.length) {
        h.replaceChildren(
          node('span', '', exam),
          node('span', 'sr-only', ' · '),
          node('span', 'account-detail-subject', sections.join(' · ')),
        );
      }
      const meta = node('div');
      const history = note(paperMeta({ ...paper, ...detail }));
      const stamp = versions.find((item) => Number(item.version) === v)?.savedAt;
      if (stamp) {
        const time = node('time', 'account-detail-date', savedDate(stamp));
        time.dateTime = stamp;
        history.append(time);
      }
      meta.append(h, history);
      if (detail.legacyInk) meta.append(note('旧记录的笔迹缺少底图版本，已保存在完整学习备份中。'));
      const choices = detail.taskChoices || [];
      let task = Number(detail.lastTask || choices[0]?.task) || undefined;
      if (choices.length && !choices.some((choice) => Number(choice.task) === task))
        task = Number(choices[0].task);
      const resume = button(
        '继续作答',
        () => perform('正在打开答卷…', () => controller.resume(id, v, task)),
        'button-primary',
      );
      const download = link('下载整卷 PDF', controller.pdfUrl(id, v), 'button-secondary');
      download.download = '';
      const nextActions = actions();
      if (choices.length > 1) {
        const choose = selector(
          choices.map((c) => [c.task, 'Task ' + c.task]),
          task,
          (value) => {
            task = Number(value);
          },
        );
        choose.setAttribute('aria-label', '继续作答的 Task');
        nextActions.append(field('继续作答的 Task', choose));
      }
      nextActions.append(resume, download);
      head.append(meta, nextActions);
      const viewer = node('section', 'account-viewer');
      const toolbar = node('div', 'account-viewer-tools');
      const versionSelect = selector(
        [...versions]
          .sort((a, b) => b.version - a.version)
          .map((item) => [
            item.version,
            item.version + (Number(item.version) === Number(paper.version) ? ' · 最新' : ''),
          ]),
        v,
        (value) => openPaper(id, Number(value), false),
      );
      meta.append(field('保存版本', versionSelect));
      const pages = detail.pages || [];
      const figure = node('figure', 'account-page');
      if (pages.length) {
        const firstAnswer = pages.findIndex((p) => p.hash) + 1;
        active.page = Math.max(1, Math.min(previousPage || firstAnswer || 1, pages.length));
        const pageSelect = selector(
          pages.map((p, i) => [
            i + 1,
            [
              i + 1 + ' / ' + pages.length,
              p.kind === 'original' && p.number
                ? (paper.part.includes('+') ? p.part + ' ' : '') + '原页 ' + p.number
                : p.label,
              p.kind === 'original' && p.hash ? '手写' : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ]),
          active.page,
          show,
        );
        const pageField = field('页码', pageSelect);
        pageField.classList.add('account-page-picker');
        const reading = node('span', 'account-page-reading');
        reading.setAttribute('aria-hidden', 'true');
        const position = node('strong'),
          source = node('small');
        reading.append(position, source);
        pageField.append(reading);
        const previous = button('上一页', () => show(active.page - 1), 'button-quiet');
        const next = button('下一页', () => show(active.page + 1), 'button-quiet');
        const original = link('', '#', 'button-text account-full-image');
        original.append(icon('expand'), node('span', '', '打开整页图'));
        original.setAttribute('aria-label', '打开整页图');
        original.title = '打开整页图';
        original.target = '_blank';
        original.rel = 'noopener';
        previous.classList.add('account-step');
        next.classList.add('account-step');
        for (const [control, symbol] of [
          [previous, 'prev'],
          [next, 'next'],
        ]) {
          control.setAttribute('aria-label', control.textContent);
          control.title = control.textContent;
          control.replaceChildren(icon(symbol));
        }
        toolbar.append(previous, pageField, next, original);
        function show(pageNumber) {
          const n = Number(pageNumber),
            page = pages[n - 1];
          active.page = n;
          pageSelect.value = String(n);
          position.textContent = n + ' / ' + pages.length;
          source.textContent =
            page.kind === 'original' && page.number
              ? [
                  (paper.part.includes('+') ? page.part + ' ' : '') + '原页 ' + page.number,
                  page.hash && '手写',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : page.label || (page.kind === 'data' ? '资料页' : '附页');
          previous.disabled = n === 1;
          next.disabled = n === pages.length;
          original.hidden = Boolean(missingPage(page));
          if (missingPage(page)) {
            figure.replaceChildren(note('本页缺少已核实的原图。'));
            return;
          }
          const img = node('img');
          img.alt = paper.title + ' · ' + (page.label || '第 ' + n + ' 页');
          const caption = node('figcaption', '', '正在载入整页图…');
          img.addEventListener('error', () => {
            img.hidden = true;
            caption.replaceChildren(
              '整页图未能载入。',
              button('重新载入', () => show(n), 'button-text'),
            );
          });
          img.addEventListener('load', () => {
            caption.hidden = true;
          });
          original.href = controller.imageUrl(id, v, n);
          img.src = original.href;
          figure.replaceChildren(caption, img);
        }
        show(active.page);
      } else figure.append(note('这次作答没有已核实的原页。'));
      viewer.append(toolbar, figure);
      const remove = button(
        '删除这份答卷',
        () => {
          if (!confirm('删除「' + paper.title + '」及其所有云端版本？此操作无法撤销。')) return;
          void perform('正在删除答卷…', async () => {
            await controller.deletePaper(id);
            active = null;
            await refresh();
            say('已删除答卷。');
            focus(title);
          });
        },
        'button-text account-danger',
      );
      const desk = node('div', 'account-desk');
      desk.append(head, viewer);
      content.replaceChildren(back, desk, remove);
      if (restoreFocus) focus(h);
      else focus(versionSelect);
    } catch (error) {
      if (!valid(seq, identity)) return;
      content.replaceChildren(
        back,
        note(error.message || '答卷暂时无法读取。'),
        button('重新读取', () => openPaper(id, v)),
      );
    }
  }
  async function refresh() {
    if (destroyed) return;
    const user = controller.state().user;
    const changed = owner !== user?.id;
    if (changed) {
      active = null;
      papers = [];
      conflict = null;
      year = '';
      part = '';
      guestTotal = 0;
      guestIssue = '';
      if (recovery?.owner !== user?.id) recovery = null;
      owner = user?.id;
      mode = 'login';
      mast.hidden = false;
      say();
      settings.replaceChildren();
      content.replaceChildren();
    }
    renderNotices();
    identity.textContent = user ? '当前账号 · ' + user.name : '';
    if (controller.state().offline) {
      if (user) identity.textContent += ' · 暂未连接账号服务';
      else if (!status.textContent) say('暂未连接账号服务。');
    }
    const seq = ++request;
    if (!user) {
      if (!content.querySelector('form')) renderAuth();
      return;
    }
    if (!content.children.length) content.append(note('正在读取答卷…'));
    try {
      const [result, guests] = await Promise.all([
        controller.list(),
        Promise.resolve()
          .then(() => controller.guestCount())
          .then(
            (count) => ({ count }),
            (error) => ({ error }),
          ),
      ]);
      if (!valid(seq, user.id)) return;
      papers = result;
      guestTotal = Number(guests.count) || 0;
      guestIssue = guests.error?.message || '';
      const expanded = settings.querySelector('details')?.open;
      renderSettings(user);
      if (expanded) settings.firstElementChild.open = true;
      if (active && papers.some((p) => p.id === active.id)) await openPaper(active.id, active.version, false);
      else renderList();
    } catch (error) {
      if (!valid(seq, user.id)) return;
      renderSettings(user);
      content.replaceChildren(
        note(error.message || '答卷列表暂时无法载入。'),
        button('重新载入答卷', refresh),
      );
    }
  }
  const changed = () => {
    if (root.hidden) return;
    if (busy && owner === controller.state().user?.id) {
      queuedRefresh = true;
      return;
    }
    void refresh();
  };
  window.addEventListener('english30-account-change', changed);
  void refresh();
  return {
    refresh,
    focusLogin() {
      if (busy || controller.state().user) return;
      if (mode !== 'login') changeMode('login');
      focus(content.querySelector('input[name="username"]'));
    },
    destroy() {
      destroyed = true;
      ++request;
      recovery = null;
      root.replaceChildren();
      window.removeEventListener('english30-account-change', changed);
    },
  };
}
