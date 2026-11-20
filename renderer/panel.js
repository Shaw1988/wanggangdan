'use strict';

const glass = document.getElementById('glass');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const input = document.getElementById('input');

const DAY = 86400000;
let todos = [];
let editingId = null;
let archiveOpen = false;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dueInfo(todo, now) {
  const due = new Date(todo.dueAt);
  const dayDiff = Math.round((startOfDay(due) - startOfDay(now)) / DAY);

  let day;
  if (dayDiff === 0) day = '今天';
  else if (dayDiff === 1) day = '明天';
  else if (dayDiff === 2) day = '后天';
  else if (dayDiff === -1) day = '昨天';
  else if (dayDiff === -2) day = '前天';
  else if (due.getFullYear() === now.getFullYear()) {
    day = `${due.getMonth() + 1}月${due.getDate()}日`;
  } else {
    day = `${due.getFullYear()}年${due.getMonth() + 1}月${due.getDate()}日`;
  }

  const label = todo.hasTime
    ? `${day} ${pad2(due.getHours())}:${pad2(due.getMinutes())}`
    : day;

  const overdue = due.getTime() < now.getTime();
  const soon = !overdue && (dayDiff === 0 || dayDiff === 1);

  let tone = 'normal';
  if (overdue) tone = 'overdue';
  else if (dayDiff === 0) tone = 'today';
  else if (dayDiff === 1) tone = 'tomorrow';

  return { label, tone, overdue, soon };
}

// 精确到分钟的短时间戳：11/19 18:42
function stamp(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function buildRow(todo, now) {
  // 已完成的行只显示完成时间，不做截止时间判定
  const info = !todo.completed && todo.dueAt ? dueInfo(todo, now) : null;
  const row = document.createElement('div');
  row.className = 'item';
  // 只有真的带时间的待办才可能有「今明两天」或「逾期」的竖线
  if (todo.completed) row.classList.add('done');
  else if (info && info.overdue) row.classList.add('overdue');
  else if (info && info.soon) row.classList.add('soon');

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.setAttribute('aria-label', todo.completed ? '标记为未完成' : '标记为完成');
  check.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';
  check.addEventListener('click', (event) => {
    event.stopPropagation();
    window.api.toggleTodo(todo.id);
  });

  const body = document.createElement('div');
  body.className = 'body';

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = todo.text;
  text.title = '点击修改';
  text.addEventListener('click', (event) => {
    event.stopPropagation();
    beginEdit(todo, text);
  });
  body.appendChild(text);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.setAttribute('aria-label', '删除');
  del.textContent = '\u00d7';
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    window.api.deleteTodo(todo.id);
  });

  // 时间标签放在勾选框之后、正文之前：
  // 未完成显示截止时间，已完成显示精确到分钟的完成时间
  let chipText = '';
  if (todo.completed) chipText = `完成 ${stamp(todo.completedAt || todo.createdAt)}`;
  else if (info) chipText = info.label;

  if (chipText) {
    const chip = document.createElement('span');
    chip.className = `chip ${todo.completed ? 'done' : info.tone}`;
    chip.textContent = chipText;
    row.append(check, chip, body, del);
  } else {
    row.append(check, body, del);
  }
  return row;
}

// 点击文本原地编辑：Enter 保存、Esc 取消、失焦保存
function beginEdit(todo, node) {
  if (editingId) return;
  const original = todo.text;
  editingId = todo.id;
  node.setAttribute('contenteditable', 'plaintext-only');
  node.classList.add('editing');
  // 编辑期间告诉主进程别因为鼠标离开就收起卷轴
  window.api.inputFocus(true);

  node.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function finish(commit) {
    node.removeEventListener('keydown', onKey);
    node.removeEventListener('blur', onBlur);
    if (!node.isConnected) {
      editingId = null;
      window.api.inputFocus(false);
      return;
    }
    const value = node.textContent.replace(/\s+/g, ' ').trim();
    node.classList.remove('editing');
    node.removeAttribute('contenteditable');
    node.textContent = value && commit ? value : original;
    editingId = null;
    window.api.inputFocus(false);
    if (commit && value && value !== original) window.api.updateTodo(todo.id, value);
    else render();
  }

  function onKey(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  }

  function onBlur() {
    finish(true);
  }

  node.addEventListener('keydown', onKey);
  node.addEventListener('blur', onBlur);
}

function render() {
  // 正在编辑时不要重建列表，否则输入框会被冲掉
  if (editingId) return;
  const now = new Date();
  const scrollTop = listEl.scrollTop;
  listEl.textContent = '';

  // 完成超过 1 个月的收进归档
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - 1);
  const cutoffTime = cutoff.getTime();

  const visible = [];
  const archived = [];
  for (const todo of todos) {
    const doneAt = todo.completed ? todo.completedAt || todo.createdAt || 0 : 0;
    if (todo.completed && doneAt < cutoffTime) archived.push(todo);
    else visible.push(todo);
  }

  for (const todo of visible) {
    listEl.appendChild(buildRow(todo, now));
  }

  if (archived.length) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'archive-toggle';
    toggle.textContent = archiveOpen
      ? `收起归档 · ${archived.length} 项`
      : `已归档 ${archived.length} 项 · 点开按月份查看`;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      archiveOpen = !archiveOpen;
      render();
    });
    listEl.appendChild(toggle);

    if (archiveOpen) {
      // todos 已按完成时间倒序，按月分组后自然是最新月份在前
      const groups = new Map();
      for (const todo of archived) {
        const d = new Date(todo.completedAt || todo.createdAt || now.getTime());
        const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(todo);
      }
      for (const [key, list] of groups) {
        const [year, month] = key.split('-');
        const head = document.createElement('div');
        head.className = 'archive-month';
        head.textContent = `${year} 年 ${month} 月 · ${list.length} 项`;
        listEl.appendChild(head);
        for (const todo of list) listEl.appendChild(buildRow(todo, now));
      }
    }
  }

  const pending = todos.filter((t) => !t.completed).length;
  if (todos.length === 0) countEl.textContent = '0 项';
  else if (pending === 0) countEl.textContent = '全部完成';
  else countEl.textContent = `${pending} 项未完成`;

  emptyEl.classList.toggle('show', todos.length === 0);
  listEl.scrollTop = scrollTop;
}

// 列表数据由主进程在页面加载完、每次打开时主动推送
window.api.onTodos((list) => {
  todos = Array.isArray(list) ? list : [];
  render();
});

window.api.onPanelAnimate((dir) => {
  glass.classList.remove('opening', 'closing');
  // 强制重排，保证连续开合时动画能重新播放
  void glass.offsetWidth;
  if (dir === 'open') {
    glass.classList.add('opening');
    input.blur();
    listEl.scrollTop = 0;
  } else {
    glass.classList.add('closing');
    // 收起时主动失焦，避免输入框焦点状态把面板“钉”住
    input.blur();
  }
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    window.api.addTodo(value);
  } else if (event.key === 'Escape') {
    input.blur();
    window.api.closePanel();
  }
});

input.addEventListener('focus', () => window.api.inputFocus(true));
input.addEventListener('blur', () => window.api.inputFocus(false));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.activeElement !== input) {
    window.api.closePanel();
  }
});

// 每 30 秒重绘一次，让“今天/明天/逾期”随时间自然更新；
// 卷轴收起时不重绘，省掉隐藏窗口里的 DOM 重建
setInterval(() => {
  if (!document.hidden) render();
}, 30000);
render();
