'use strict';

const pet = document.getElementById('pet');
const clock = document.getElementById('clock');
const clockTime = document.getElementById('clockTime');
const clockSecond = document.getElementById('clockSecond');
const clockDate = document.getElementById('clockDate');
const clockWeekday = document.getElementById('clockWeekday');
const clockLunar = document.getElementById('clockLunar');
const layers = Array.from(document.querySelectorAll('.layer'));

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

let dragging = false;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ---------- 农历：直接用系统的中文历法，不额外背万年历表 ---------- */

const lunarFmt = (() => {
  try {
    return new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'long',
      day: 'numeric'
    });
  } catch (err) {
    return null;
  }
})();

function lunarDayName(n) {
  if (n === 10) return '初十';
  if (n < 10) return `初${CN_NUM[n - 1]}`;
  if (n === 20) return '二十';
  if (n === 30) return '三十';
  if (n < 20) return `十${CN_NUM[n - 11]}`;
  return `廿${CN_NUM[n - 21]}`;
}

function lunarLabel(date) {
  if (!lunarFmt) return '';
  try {
    const parts = lunarFmt.formatToParts(date);
    const month = (parts.find((p) => p.type === 'month') || {}).value || '';
    const day = Number((parts.find((p) => p.type === 'day') || {}).value);
    if (!month || !day) return '';
    return `农历${month}${lunarDayName(day)}`;
  } catch (err) {
    return '';
  }
}

/* ---------- 数字时钟 ---------- */

let lastMinute = '';
let lastDayKey = '';

function renderClock() {
  // 主角形态下时钟是 display:none，不跟着每秒空转
  if (!document.body.classList.contains('clock-mode')) return;

  const now = new Date();
  const minute = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  if (minute !== lastMinute) {
    lastMinute = minute;
    clockTime.textContent = minute;
  }
  clockSecond.textContent = pad2(now.getSeconds());

  // 日期、周几、农历只在跨天时重算（农历格式化相对贵）
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (dayKey !== lastDayKey) {
    lastDayKey = dayKey;
    clockDate.textContent = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())}`;
    clockWeekday.textContent = `周${WEEK[now.getDay()]}`;
    clockLunar.textContent = lunarLabel(now);
  }
}

setInterval(renderClock, 1000);

/* ---------- 王钢蛋本体状态 ---------- */

function applyState(state) {
  if (!state) return;
  const show = state.active ? 3 : state.idle || 1;
  const incoming = layers.find((layer) => Number(layer.dataset.index) === show);
  if (!incoming) return;

  // 直接切换：同一帧里旧图隐藏、新图显示，避免交叉淡入淡出造成重影
  layers.forEach((layer) => {
    layer.classList.toggle('on', layer === incoming);
  });
}

function applyMode(mode) {
  document.body.classList.remove('pet-mode', 'clock-mode');
  const value = mode === 'clock' ? 'clock' : 'pet';
  document.body.classList.add(`${value}-mode`);
  // 切到时钟时立刻画一帧，不用等下一秒
  if (value === 'clock') renderClock();
}

/* ---------- IPC ---------- */

window.api.onCharState(applyState);
window.api.onCharMode(applyMode);

/* ---------- 拖拽 ---------- */

function beginDrag(event) {
  if (event.button !== 0) return;
  dragging = true;
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch (err) { /* ignore */ }
  document.body.classList.add('dragging');
  window.api.dragStart();
}

pet.addEventListener('pointerdown', beginDrag);
clock.addEventListener('pointerdown', beginDrag);

function stopDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  window.api.dragEnd();
}

for (const el of [pet, clock]) {
  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);
}
window.addEventListener('pointerup', stopDrag, true);
window.addEventListener('mouseup', stopDrag, true);
window.addEventListener('blur', stopDrag);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopDrag();
});
