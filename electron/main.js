'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage,
  Notification, shell
} = require('electron');
const store = require('./store');

// Windows 上透明置顶窗口会被 Chromium 误判为「被遮挡」，导致动画冻结、showInactive 偶发失效
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const CHAR_W = 220;
const CHAR_H = 230;
const CARD_W = 360;
const CARD_H = 600;
const PAD = 30;
const PANEL_W = CARD_W + PAD * 2;
const PANEL_H = CARD_H + PAD * 2;
const HOVER_OPEN_DELAY = 45;
const HOVER_CLOSE_DELAY = 120;
const CLOSE_ANIM_MS = 260;
// 40ms 一次：25ms 时每秒 40 次唤醒，对悬停判断没有实际收益
const HOVER_POLL_MS = 40;
const DRAG_MAX_MS = 12000;

// 尺寸三档：以现有大小为「大」，2/3 为「中」，1/2 为「小」
const SIZES = {
  large: { label: '大', scale: 1 },
  medium: { label: '中', scale: 2 / 3 },
  small: { label: '小', scale: 1 / 2 }
};

// 卷轴固定用「中」档的大小，三档尺寸下都不变
const PANEL_SCALE = SIZES.medium.scale;

let charWin = null;
let panelWin = null;
let tray = null;
let idleIndex = 1;
let hoveringChar = false;
let hoveringPanel = false;
let panelOpen = false;
let dragging = false;
let suppressHover = false;
let rotateTimer = null;
let openTimer = null;
let closeTimer = null;
let hideAnimTimer = null;
let dragState = null;
let dragStartedAt = 0;
let lastSizeCheck = 0;
let panelReady = false;
let panelShownAt = 0;
let hoverWatch = null;
let panelInputFocused = false;
let sizeKey = 'large';
let scale = 1;
let savedPos = null;
// 桌面形态：pet = 王钢蛋本体，clock = 数字时钟
let mode = 'pet';
let autoLaunch = false;

/* ---------------- 设置持久化 ---------------- */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (raw && SIZES[raw.size]) sizeKey = raw.size;
    if (raw && raw.pos && Number.isFinite(raw.pos.x) && Number.isFinite(raw.pos.y)) {
      savedPos = { x: Math.round(raw.pos.x), y: Math.round(raw.pos.y) };
    }
    if (raw && raw.mode) {
      // 老 setting 里可能有三档：clock/pixel/dial 都归到新的 clock 档
      if (raw.mode === 'pet') mode = 'pet';
      else mode = 'clock';
    }
    if (raw) autoLaunch = !!raw.autoLaunch;
  } catch (err) {
    /* 首次运行没有设置文件 */
  }
  scale = SIZES[sizeKey].scale;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify(
        { size: sizeKey, pos: savedPos, mode, autoLaunch },
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    console.error('[settings] 保存失败', err);
  }
}

// 开机自启动只在安装后的版本里真正写系统项；
// 开发模式下 process.execPath 是 electron.exe，写进去会变成开机弹控制台
function applyAutoLaunch() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: autoLaunch, path: process.execPath });
  } catch (err) {
    console.error('[autolaunch] 设置失败', err);
  }
}

function setAutoLaunch(enabled) {
  autoLaunch = !!enabled;
  saveSettings();
  applyAutoLaunch();
  refreshTrayMenu();
}

// 记住拖动后的位置，下次启动原位出现
function rememberPosition() {
  if (!charWin || charWin.isDestroyed()) return;
  const b = charWin.getBounds();
  savedPos = { x: b.x, y: b.y };
  saveSettings();
}

function charSize() {
  return {
    width: Math.max(1, Math.round(CHAR_W * scale)),
    height: Math.max(1, Math.round(CHAR_H * scale))
  };
}

function panelSize() {
  return {
    width: Math.max(1, Math.round(PANEL_W * PANEL_SCALE)),
    height: Math.max(1, Math.round(PANEL_H * PANEL_SCALE))
  };
}

// 兜底：万一窗口尺寸被系统 DPI 换算搞歪了，强制拉回当前档位应有的尺寸
function normalizeCharSize() {
  if (!charWin || charWin.isDestroyed()) return;
  const b = charWin.getBounds();
  const cs = charSize();
  // 允许 1~2px 的 DPI 取整误差，只有明显跑偏（被拖大）才纠正
  if (Math.abs(b.width - cs.width) <= 2 && Math.abs(b.height - cs.height) <= 2) return;
  charWin.setBounds({ x: b.x, y: b.y, width: cs.width, height: cs.height });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDue(todo) {
  if (!todo.dueAt) return '';
  const d = new Date(todo.dueAt);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return todo.hasTime ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}

/* ---------------- 窗口 ---------------- */

// 启动位置：优先用上次拖动后的位置；那块屏不在了就钳回最近的工作区
function initialCharPosition(size) {
  const { workArea } = screen.getPrimaryDisplay();
  const fallback = {
    x: workArea.x + workArea.width - size.width - 48,
    y: workArea.y + workArea.height - size.height - 48
  };
  if (!savedPos) return fallback;
  const display = screen.getDisplayMatching({
    x: savedPos.x,
    y: savedPos.y,
    width: size.width,
    height: size.height
  });
  const wa = display.workArea;
  return {
    x: Math.round(Math.min(Math.max(savedPos.x, wa.x - size.width + 48), wa.x + wa.width - 48)),
    y: Math.round(Math.min(Math.max(savedPos.y, wa.y - size.height + 48), wa.y + wa.height - 48))
  };
}

function createCharacterWindow() {
  const size = charSize();
  const pos = initialCharPosition(size);
  charWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 不再置顶：王钢蛋待在普通层（最下层），被其他窗口覆盖是预期行为
    alwaysOnTop: false,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  charWin.setMenu(null);
  charWin.loadFile(path.join(__dirname, '..', 'renderer', 'character.html'));
  // 用 show() 而不是 showInactive()：focusable:false 的窗口无法被激活，
  // 但 showInactive 在 Windows 上有时不会让合成器真正开始绘制，导致动画卡住
  charWin.once('ready-to-show', () => {
    charWin.show();
  });
  charWin.webContents.on('did-finish-load', () => {
    charWin.webContents.setZoomFactor(scale);
    broadcastCharState();
    sendCharMode();
  });
  charWin.webContents.on('render-process-gone', () => {
    if (charWin && !charWin.isDestroyed()) charWin.webContents.reload();
  });
  charWin.on('closed', () => {
    charWin = null;
  });
}

function createPanelWindow() {
  const size = panelSize();
  panelWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 卷轴是角色窗口的附属窗口：只保证盖在角色上面，
    // 不再永久占据屏幕最上层，避免误触时压住用户正在用的窗口
    alwaysOnTop: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 面板创建后一直隐藏，没必要在显示前就生成合成帧
      paintWhenInitiallyHidden: false,
      // 面板隐藏时必须让渲染进程停下来，
      // 否则阴影、噪点这些图层在隐藏状态下仍会持续合成，拖慢主进程，
      // 托盘右键菜单就会「很久才弹出来」
      backgroundThrottling: true
    }
  });
  panelWin.setMenu(null);
  panelWin.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  panelWin.webContents.on('render-process-gone', () => {
    panelReady = false;
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.reload();
  });
  panelWin.webContents.on('did-finish-load', () => {
    panelWin.webContents.setZoomFactor(PANEL_SCALE);
    panelReady = true;
    sendTodos();
  });
  panelWin.on('closed', () => {
    panelWin = null;
    panelReady = false;
  });
}

function positionPanel() {
  if (!panelWin || !charWin) return;
  const b = charWin.getBounds();
  const ps = panelSize();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = display.workArea;

  // 卡片实际可见尺寸（窗口四周有一圈透明留白，方便画阴影）
  const cardW = CARD_W * PANEL_SCALE;
  const cardH = CARD_H * PANEL_SCALE;
  const pad = PAD * PANEL_SCALE;
  const clampX = (v) => Math.min(Math.max(v, wa.x + 8), wa.x + wa.width - cardW - 8);
  const clampY = (v) => Math.min(Math.max(v, wa.y + 8), wa.y + wa.height - cardH - 8);

  // 默认：卷轴贴在角色左侧
  let cardX = clampX(b.x + 2 * scale - cardW);
  let cardY = clampY(b.y + 34 * scale - cardH);

  // 角色贴着屏幕左侧时，卡片会被钳回屏幕内而盖住本体，
  // 这时改成从角色右侧弹出，保证本体始终能点到、能拖。
  // 默认布局本来就和本体有 2px 重叠（视觉上贴着），这里留 6px 容差，
  // 只有真正压到本体才翻转
  const gap = Math.round(8 * scale);
  const slack = Math.round(6 * scale);
  const overlapsChar = (x, y) =>
    x < b.x + b.width - slack &&
    x + cardW > b.x + slack &&
    y < b.y + b.height - slack &&
    y + cardH > b.y + slack;
  if (overlapsChar(cardX, cardY)) {
    // 再加上 pad，让卷轴窗口的透明留白也避开本体，不挡点击
    const rightX = clampX(b.x + b.width + gap + pad);
    if (!overlapsChar(rightX, cardY)) cardX = rightX;
  }

  const target = {
    x: Math.round(cardX - pad),
    y: Math.round(cardY - pad),
    width: ps.width,
    height: ps.height
  };
  // 位置没变就不要调 setBounds：Windows 上每次 SetWindowPos 都会排队等
  // 合成器，打开卷轴时能明显感觉到延迟
  const cur = panelWin.getBounds();
  if (
    cur.x === target.x &&
    cur.y === target.y &&
    cur.width === target.width &&
    cur.height === target.height
  ) {
    return;
  }
  panelWin.setBounds(target);
}

function broadcastCharState() {
  if (!charWin || charWin.isDestroyed()) return;
  charWin.webContents.send('char:state', {
    idle: idleIndex,
    active: panelOpen || hoveringChar || hoveringPanel
  });
}

function sendTodos() {
  if (!panelWin || panelWin.isDestroyed() || !panelReady) return;
  panelWin.webContents.send('todos:updated', store.sortedTodos());
}

/* ---------------- 本体形态 ---------------- */

function sendCharMode() {
  if (!charWin || charWin.isDestroyed()) return;
  charWin.webContents.send('char:mode', mode);
}

function setMode(next) {
  if (!['pet', 'clock'].includes(next) || next === mode) return;
  mode = next;
  saveSettings();
  sendCharMode();
  broadcastCharState();
  refreshTrayMenu();
}

/* ---------------- 面板开合 ---------------- */

function openPanel() {
  if (!panelWin || panelOpen || dragging) return;
  clearTimeout(closeTimer);
  clearTimeout(hideAnimTimer);
  if (!panelReady) {
    // 刚启动时面板页面还没加载完，光标可能已经停在角色上，补一次重试
    setTimeout(() => {
      if (hoveringChar && !panelOpen && !dragging) openPanel();
    }, 200);
    return;
  }
  panelOpen = true;
  hoveringPanel = false;
  panelShownAt = Date.now();
  positionPanel();
  panelWin.showInactive();
  // Windows 偶发 showInactive 没真正显示（被前台窗口抢焦点），补一次
  if (!panelWin.isVisible()) {
    setTimeout(() => {
      if (panelOpen && panelWin && !panelWin.isDestroyed()) panelWin.showInactive();
    }, 60);
  }
  panelWin.webContents.send('panel:animate', 'open');
  sendTodos();
  broadcastCharState();
}

function closePanel(immediate = false) {
  if (!panelWin || !panelOpen) return;
  panelOpen = false;
  hoveringPanel = false;
  panelInputFocused = false;
  cancelOpen();
  clearTimeout(closeTimer);
  closeTimer = null;
  clearTimeout(hideAnimTimer);
  if (panelReady) panelWin.webContents.send('panel:animate', 'close');
  if (immediate) {
    panelWin.hide();
  } else {
    hideAnimTimer = setTimeout(() => {
      hideAnimTimer = null;
      if (!panelOpen && panelWin) panelWin.hide();
    }, CLOSE_ANIM_MS);
    // 收起卷轴回到待机状态时换个坐姿，避免看起来一动不动
    idleIndex = idleIndex === 1 ? 2 : 1;
  }
  broadcastCharState();
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (panelInputFocused) return;
    if (!hoveringChar && !hoveringPanel) closePanel();
  }, HOVER_CLOSE_DELAY);
}

function pointInside(bounds, point, inset) {
  return (
    point.x >= bounds.x + inset &&
    point.x <= bounds.x + bounds.width - inset &&
    point.y >= bounds.y + inset &&
    point.y <= bounds.y + bounds.height - inset
  );
}

// 用主进程轮询光标判断悬停：Windows 上透明无边框窗口在面板弹出时
// 会收到一次虚假的 mouseleave，导致面板刚打开就立刻收起
function startHoverWatch() {
  clearInterval(hoverWatch);
  hoverWatch = setInterval(() => {
    if (!charWin || charWin.isDestroyed()) return;

    // 拖动兜底：pointerup 丢失且光标一直停在角色上时，看门狗（看光标是否离开）
    // 永远不触发，这里用总时长强制收尾，否则悬停会永久失效
    if (dragging) {
      if (dragStartedAt && Date.now() - dragStartedAt > DRAG_MAX_MS) endDrag();
      return;
    }

    // 定期校正窗口尺寸，避免 DPI 换算把窗口越拖越大
    if (Date.now() - lastSizeCheck > 2000) {
      lastSizeCheck = Date.now();
      normalizeCharSize();
    }

    const cursor = screen.getCursorScreenPoint();
    const charInset = Math.max(2, Math.round(8 * scale));

    const inChar = pointInside(charWin.getBounds(), cursor, charInset);
    if (inChar !== hoveringChar) onCharHover(inChar);

    // 自愈：状态已关闭、也没有收起动画在跑，但窗口还留在屏幕上
    if (
      !panelOpen &&
      !hideAnimTimer &&
      panelWin &&
      !panelWin.isDestroyed() &&
      panelWin.isVisible()
    ) {
      panelWin.hide();
    }

    if (panelOpen) {
      // 自愈：窗口被系统或其它原因弄没了，但面板状态还停在「打开」，
      // 会导致之后鼠标怎么悬停都打不开
      if (
        panelWin &&
        !panelWin.isDestroyed() &&
        !panelWin.isVisible() &&
        Date.now() - panelShownAt > 600
      ) {
        panelOpen = false;
        hoveringPanel = false;
        broadcastCharState();
        return;
      }
      if (!panelWin || panelWin.isDestroyed()) {
        panelOpen = false;
        hoveringPanel = false;
        broadcastCharState();
        return;
      }

      // 整个面板窗口都算悬停区域，避免光标经过面板外圈时被误判为离开
      const inPanel = pointInside(
        panelWin.getBounds(),
        cursor,
        Math.max(2, Math.round(4 * PANEL_SCALE))
      );
      if (inPanel !== hoveringPanel) {
        hoveringPanel = inPanel;
        if (inPanel) clearTimeout(closeTimer);
        else if (!hoveringChar && !panelInputFocused) scheduleClose();
        broadcastCharState();
      } else if (
        !inPanel &&
        !hoveringChar &&
        !panelInputFocused &&
        !closeTimer &&
        !hideAnimTimer
      ) {
        // 自愈：已经离开角色和面板但没有任何收起计时在跑
        scheduleClose();
      }
    }
  }, HOVER_POLL_MS);
}

/* ---------------- 小助手悬停 / 拖动 ---------------- */

function scheduleOpen() {
  if (!hoveringChar || dragging || suppressHover || panelOpen) return;
  // 已有待触发的计时就不要重置，否则鼠标在角色上持续移动会永远等不到打开
  if (openTimer) return;
  openTimer = setTimeout(() => {
    openTimer = null;
    if (!hoveringChar || dragging || suppressHover) return;
    openPanel();
  }, HOVER_OPEN_DELAY);
}

function cancelOpen() {
  clearTimeout(openTimer);
  openTimer = null;
}

function onCharHover(inside) {
  hoveringChar = inside;
  if (inside) {
    clearTimeout(closeTimer);
    if (suppressHover || dragging) return;
    scheduleOpen();
    broadcastCharState();
  } else {
    suppressHover = false;
    cancelOpen();
    if (!hoveringPanel) scheduleClose();
    broadcastCharState();
  }
}

function startDrag() {
  if (!charWin) return;
  const b = charWin.getBounds();
  // 尺寸用「拖动开始那一刻」的真实值固定住，全程不再重新读取。
  // Windows 125% 缩放下反复 setPosition 会做 DIP↔像素来回换算，
  // 每调一次窗口就长大一点，按住不动也会疯狂变大
  const w = b.width;
  const h = b.height;
  const cursor = screen.getCursorScreenPoint();
  dragging = true;
  dragStartedAt = Date.now();
  suppressHover = true;
  cancelOpen();
  closePanel(true);
  clearInterval(dragState && dragState.timer);
  dragState = {
    offX: cursor.x - b.x,
    offY: cursor.y - b.y,
    width: w,
    height: h,
    lastX: b.x,
    lastY: b.y,
    outsideFor: 0,
    timer: setInterval(() => {
      if (!dragState || !charWin || charWin.isDestroyed()) return;
      const cur = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cur);
      const wa = display.workArea;
      let x = Math.round(cur.x - dragState.offX);
      let y = Math.round(cur.y - dragState.offY);
      x = Math.min(Math.max(x, wa.x - 24), wa.x + wa.width - dragState.width + 24);
      y = Math.min(Math.max(y, wa.y - 24), wa.y + wa.height - dragState.height + 24);

      // 只有真的移动了才动窗口；位置不变时一次都不调系统接口
      if (x !== dragState.lastX || y !== dragState.lastY) {
        dragState.lastX = x;
        dragState.lastY = y;
        charWin.setBounds({ x, y, width: dragState.width, height: dragState.height });
      }

      // 保险：如果渲染进程没收到 pointerup（透明窗口偶尔会丢），
      // 光标离开角色窗超过 260ms 就强制结束拖动，否则悬停会一直失效
      const rect = {
        x: dragState.lastX,
        y: dragState.lastY,
        width: dragState.width,
        height: dragState.height
      };
      if (pointInside(rect, cur, 0)) {
        dragState.outsideFor = 0;
      } else {
        dragState.outsideFor += 16;
        if (dragState.outsideFor > 260) endDrag();
      }
    }, 16)
  };
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  dragStartedAt = 0;
  if (dragState) clearInterval(dragState.timer);
  dragState = null;
  // 关键修复：松手时光标通常还停在角色身上，不会再有 mouseenter，
  // 旧逻辑把 suppressHover 留成 true，导致只切图3、永远不打开卷轴
  suppressHover = false;
  if (charWin && !charWin.isDestroyed()) {
    hoveringChar = pointInside(
      charWin.getBounds(),
      screen.getCursorScreenPoint(),
      Math.max(2, Math.round(8 * scale))
    );
  }
  if (hoveringChar) {
    // 松手后给一点缓冲，避免刚放下就被卷轴盖住
    cancelOpen();
    openTimer = setTimeout(() => {
      openTimer = null;
      if (hoveringChar && !dragging && !suppressHover) openPanel();
    }, 350);
  }
  // 提前把面板摆到新位置，下次打开就不用再等 SetWindowPos
  positionPanel();
  normalizeCharSize();
  rememberPosition();
  broadcastCharState();
}

/* ---------------- 导出 ---------------- */

function buildMarkdown(todos, now) {
  const pending = todos.filter((t) => !t.completed);
  const done = todos.filter((t) => t.completed);
  // 每一条都带时间戳：未完成有创建时间（和截止时间），已完成加上完成时间
  const line = (t) => {
    const tags = [`创建 ${fmtDateTime(new Date(t.createdAt || now.getTime()))}`];
    if (t.dueAt) tags.push(`截止 ${fmtDue(t)}`);
    if (t.completed && t.completedAt) tags.push(`完成 ${fmtDateTime(new Date(t.completedAt))}`);
    return `- [${t.completed ? 'x' : ' '}] ${t.text}  ${tags.map((s) => `\`${s}\``).join(' ')}`;
  };
  const lines = [
    '# 王钢蛋 · 待办事项',
    '',
    `> 导出时间：${fmtDateTime(now)}`,
    '',
    `## 未完成（${pending.length}）`,
    '',
    ...(pending.length ? pending.map(line) : ['_暂无_']),
    '',
    `## 已完成（${done.length}）`,
    '',
    ...(done.length ? done.map(line) : ['_暂无_']),
    ''
  ];
  return lines.join('\r\n');
}

function exportTodos() {
  const now = new Date();
  const todos = store.sortedTodos(now);
  const content = buildMarkdown(todos, now);
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const file = path.join(app.getPath('desktop'), `王钢蛋待办_${stamp}.txt`);
  try {
    fs.writeFileSync(file, content, 'utf8');
    if (Notification.isSupported()) {
      new Notification({
        title: '已导出待办',
        body: `已保存到桌面：${path.basename(file)}`,
        silent: true
      }).show();
    }
    shell.showItemInFolder(file);
  } catch (err) {
    console.error('[export] 导出失败', err);
    shell.openPath(app.getPath('desktop'));
  }
}

/* ---------------- 关于 ---------------- */

let aboutWin = null;

function showAbout() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 360,
    height: 430,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  aboutWin.setMenu(null);
  aboutWin.loadFile(path.join(__dirname, '..', 'renderer', 'about.html'), {
    query: { v: app.getVersion() }
  });
  aboutWin.once('ready-to-show', () => aboutWin.show());
  // 窗口里的链接一律交给系统浏览器，不在应用内打开
  aboutWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 兜底：任何页内跳转也丢给浏览器
  aboutWin.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  aboutWin.on('closed', () => {
    aboutWin = null;
  });
}

/* ---------------- 托盘 ---------------- */

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '导出所有待办', click: () => exportTodos() },
    { type: 'separator' },
    {
      label: '大小',
      submenu: Object.keys(SIZES).map((key) => ({
        label: SIZES[key].label,
        type: 'radio',
        checked: key === sizeKey,
        click: () => setSize(key)
      }))
    },
    {
      label: '桌面形态',
      submenu: [
        { label: '王钢蛋本体', type: 'radio', checked: mode === 'pet', click: () => setMode('pet') },
        { label: '数字时钟', type: 'radio', checked: mode === 'clock', click: () => setMode('clock') }
      ]
    },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: autoLaunch,
      click: (item) => setAutoLaunch(item.checked)
    },
    { type: 'separator' },
    { label: '关于“王钢蛋”', click: () => showAbout() },
    { label: '关闭', click: () => app.quit() }
  ]);
}

function applyScale() {
  scale = SIZES[sizeKey].scale;
  if (charWin && !charWin.isDestroyed()) {
    const b = charWin.getBounds();
    const cs = charSize();
    const cx = b.x + b.width / 2;
    const by = b.y + b.height;
    const wa = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(by) }).workArea;
    const x = Math.min(Math.max(Math.round(cx - cs.width / 2), wa.x), wa.x + wa.width - cs.width);
    const y = Math.min(Math.max(Math.round(by - cs.height), wa.y), wa.y + wa.height - cs.height);
    charWin.setBounds({ x, y, width: cs.width, height: cs.height });
    charWin.webContents.setZoomFactor(scale);
  }
  // 卷轴大小固定为「中」档，切尺寸时不再动面板窗口：
  // 之前每次都 resize + 重新缩放面板，会把整个 blur 图层重排一遍，
  // 点击托盘后就会「卡一下」才恢复
  closePanel(true);
  positionPanel();
  rememberPosition();
}

function setSize(key) {
  if (!SIZES[key] || key === sizeKey) return;
  sizeKey = key;
  saveSettings();
  applyScale();
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  // 菜单只在尺寸变化时重建一次，右键时直接用现成的，
  // 避免每次点击都在主线程上重新建一遍原生菜单
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) icon = icon.resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('王钢蛋 · 桌面待办');
  refreshTrayMenu();
  tray.on('click', () => {
    if (!charWin) return;
    charWin.showInactive();
  });
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.on('char:drag-start', () => startDrag());
  ipcMain.on('char:drag-end', () => endDrag());

  ipcMain.on('panel:input-focus', (_e, focused) => {
    panelInputFocused = !!focused;
    if (panelInputFocused) clearTimeout(closeTimer);
    else if (!hoveringChar && !hoveringPanel) scheduleClose();
  });

  ipcMain.on('panel:close', () => closePanel());

  ipcMain.handle('todos:add', (_e, text) => {
    const item = store.add(text);
    sendTodos();
    return { ok: !!item, item };
  });

  ipcMain.handle('todos:update', (_e, id, text) => {
    const item = store.update(id, text);
    if (item) sendTodos();
    return { ok: !!item, item };
  });

  ipcMain.handle('todos:toggle', (_e, id) => {
    const ok = store.toggle(id);
    if (ok) sendTodos();
    return ok;
  });

  ipcMain.handle('todos:delete', (_e, id) => {
    const ok = store.remove(id);
    if (ok) sendTodos();
    return ok;
  });
}

/* ---------------- 启动 ---------------- */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (charWin) charWin.showInactive();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.wanggangdan.todo');
    loadSettings();
    registerIpc();
    createCharacterWindow();
    createPanelWindow();
    if (panelWin && charWin) panelWin.setParentWindow(charWin);
    positionPanel();
    createTray();
    applyAutoLaunch();

    rotateTimer = setInterval(() => {
      idleIndex = idleIndex === 1 ? 2 : 1;
      broadcastCharState();
    }, 60000);

    startHoverWatch();

    screen.on('display-metrics-changed', () => {
      if (!charWin) return;
      const b = charWin.getBounds();
      const cs = charSize();
      const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
      const x = Math.min(Math.max(b.x, wa.x - 24), wa.x + wa.width - cs.width + 24);
      const y = Math.min(Math.max(b.y, wa.y - 24), wa.y + wa.height - cs.height + 24);
      charWin.setBounds({ x, y, width: cs.width, height: cs.height });
    });
  });

  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  });

  app.on('before-quit', () => {
    clearInterval(rotateTimer);
    cancelOpen();
    clearTimeout(closeTimer);
    clearTimeout(hideAnimTimer);
    if (dragState) clearInterval(dragState.timer);
  });
}
