'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { parseDateTime } = require('./parser');

const DAY = 86400000;

let filePath = null;
let todos = [];
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  filePath = path.join(app.getPath('userData'), 'todos.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw && raw.todos)) {
      todos = raw.todos.filter((t) => t && typeof t.text === 'string');
    }
  } catch (err) {
    todos = [];
  }
  migrateParsedTimes();
}

// 老数据可能是旧版解析器算出来的（例如“今天上午”被存成 23:59、
// “11.19”没被识别成日期）。按创建时间重新解析一遍，幂等。
function migrateParsedTimes() {
  let changed = false;
  for (const t of todos) {
    if (!t.dueAt || !t.text) continue;
    const parsed = parseDateTime(t.text, new Date(t.createdAt || Date.now()));
    if (!parsed.dueAt) continue;
    if (parsed.dueAt.getTime() !== t.dueAt || !!parsed.hasTime !== !!t.hasTime) {
      t.dueAt = parsed.dueAt.getTime();
      t.hasTime = !!parsed.hasTime;
      changed = true;
    }
  }
  if (changed) save();
}

function save() {
  ensureLoaded();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, todos }, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[store] 保存失败', err);
  }
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * 置顶组：0 = 有截止时间且已到期/今天/明天，1 = 其余
 * 置顶组内按截止时间升序，其余按修改时间倒序（刚建/刚改的在最上面）
 */
function groupMeta(todo, now) {
  if (!todo.dueAt) return { group: 1, rank: 0 };
  const todayEnd = endOfDay(now).getTime();
  const tomorrowEnd = todayEnd + DAY;
  if (todo.dueAt <= tomorrowEnd) return { group: 0, rank: todo.dueAt };
  return { group: 1, rank: 0 };
}

// 未完成项的「新鲜度」：以最后修改时间为准，从没改过的用创建时间
function modifiedAt(todo) {
  return todo.updatedAt || todo.createdAt || 0;
}

function sortedTodos(now = new Date()) {
  ensureLoaded();
  const list = todos.slice();
  const pending = list
    .filter((t) => !t.completed)
    .sort((a, b) => {
      const ma = groupMeta(a, now);
      const mb = groupMeta(b, now);
      if (ma.group !== mb.group) return ma.group - mb.group;
      if (ma.group === 0) return ma.rank - mb.rank || modifiedAt(b) - modifiedAt(a);
      return modifiedAt(b) - modifiedAt(a);
    });
  // 已完成：最新勾选的排在最上面
  const done = list
    .filter((t) => t.completed)
    .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
  return pending.concat(done);
}

function add(text) {
  ensureLoaded();
  const content = String(text || '').trim();
  if (!content) return null;
  const now = Date.now();
  const parsed = parseDateTime(content, new Date());
  const todo = {
    id: crypto.randomUUID(),
    text: content,
    createdAt: now,
    updatedAt: now,
    dueAt: parsed.dueAt ? parsed.dueAt.getTime() : null,
    hasTime: !!parsed.hasTime,
    completed: false,
    completedAt: null
  };
  todos.push(todo);
  save();
  return todo;
}

// 编辑已有待办：重新解析时间词，并把修改时间刷成最新（排序按修改时间走）
function update(id, text) {
  ensureLoaded();
  const todo = todos.find((t) => t.id === id);
  if (!todo) return null;
  const content = String(text || '').trim();
  if (!content || content === todo.text) return todo;
  const parsed = parseDateTime(content, new Date());
  todo.text = content;
  todo.dueAt = parsed.dueAt ? parsed.dueAt.getTime() : null;
  todo.hasTime = !!parsed.hasTime;
  todo.updatedAt = Date.now();
  save();
  return todo;
}

function toggle(id) {
  ensureLoaded();
  const todo = todos.find((t) => t.id === id);
  if (!todo) return false;
  todo.completed = !todo.completed;
  todo.completedAt = todo.completed ? Date.now() : null;
  // 取消勾选也算一次修改，回到未完成列表时排到前面
  todo.updatedAt = Date.now();
  save();
  return true;
}

function remove(id) {
  ensureLoaded();
  const next = todos.filter((t) => t.id !== id);
  if (next.length === todos.length) return false;
  todos = next;
  save();
  return true;
}

module.exports = { sortedTodos, add, update, toggle, remove };
