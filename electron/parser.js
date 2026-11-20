'use strict';

/**
 * 中文日期时间解析器
 * 输入一句待办文本，识别其中的日期 / 时间表达，返回截止时间。
 * 识别不到时间时 dueAt 为 null，待办按普通事项处理。
 */

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
};

const WEEK_INDEX = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0
};

/** 全角转半角（保留中文标点语义） */
function toHalfWidth(input) {
  return String(input)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 中文数字 / 阿拉伯数字 → 整数，支持 0-99 与“十/二十三”等写法 */
function cnToInt(value) {
  if (value === undefined || value === null) return NaN;
  const s = toHalfWidth(String(value)).trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!/^[零〇一二两三四五六七八九十]+$/.test(s)) return NaN;
  if (s === '十') return 10;
  if (s.length === 1) return CN_DIGITS[s];
  const parts = s.split('十');
  if (parts.length === 2) {
    const tens = parts[0] ? CN_DIGITS[parts[0]] : 1;
    const ones = parts[1] ? CN_DIGITS[parts[1]] : 0;
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }
  return NaN;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

const PERIOD_RE = /(凌晨|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜间|半夜|今晚|明晚|昨晚|今早|明早)/;
const CN_NUM = '[零〇一二两三四五六七八九十]{1,3}';

// 只写了“上午/下午/晚上”而没写具体几点时，按该时段结束时间算截止，
// 否则一律算 23:59 会让“今天上午”在当晚仍然是未到期
const PERIOD_END = {
  凌晨: [6, 0],
  清晨: [8, 0],
  早晨: [12, 0],
  早上: [12, 0],
  上午: [12, 0],
  中午: [13, 0],
  下午: [18, 0],
  傍晚: [19, 0],
  晚上: [23, 59],
  夜里: [23, 59],
  夜间: [23, 59]
};

/**
 * @param {string} raw 待办原文
 * @param {Date} [now] 当前时间（便于测试）
 * @returns {{dueAt: Date|null, hasDate: boolean, hasTime: boolean}}
 */
function parseDateTime(raw, now = new Date()) {
  const text = toHalfWidth(raw || '');
  const base = startOfDay(now);
  const empty = { dueAt: null, hasDate: false, hasTime: false };

  // ---------- 1. 相对时间：X 小时后 / X 分钟后 / 半小时后 / X 天后 ----------
  let m = text.match(new RegExp(`(\\d{1,3}|${CN_NUM})\\s*个?\\s*(?:小时|钟头)\\s*(?:之?后|以后)`));
  if (m) {
    const n = cnToInt(m[1]);
    if (Number.isFinite(n) && n >= 0) {
      return { dueAt: new Date(now.getTime() + n * 3600000), hasDate: true, hasTime: true };
    }
  }
  if (/半\s*个?\s*(?:小时|钟头)\s*(?:之?后|以后)/.test(text)) {
    return { dueAt: new Date(now.getTime() + 30 * 60000), hasDate: true, hasTime: true };
  }
  m = text.match(new RegExp(`(\\d{1,3}|${CN_NUM})\\s*个?\\s*分(?:钟)?\\s*(?:之?后|以后)`));
  if (m) {
    const n = cnToInt(m[1]);
    if (Number.isFinite(n) && n >= 0) {
      return { dueAt: new Date(now.getTime() + n * 60000), hasDate: true, hasTime: true };
    }
  }
  m = text.match(new RegExp(`(\\d{1,2}|${CN_NUM})\\s*天\\s*(?:之?后|以后)`));
  if (m) {
    const n = cnToInt(m[1]);
    if (Number.isFinite(n) && n >= 0) {
      return { dueAt: new Date(now.getTime() + n * 86400000), hasDate: true, hasTime: false };
    }
  }

  // ---------- 2. 日期 ----------
  let hasDate = false;
  let year = null;
  let month = null;
  let day = null;

  // 2026-11-20 / 2026/11/20
  m = text.match(/(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  if (m) {
    year = +m[1];
    month = +m[2];
    day = +m[3];
    hasDate = true;
  }

  // 11月20日 / 十一月二十号
  if (!hasDate) {
    m = text.match(new RegExp(`(${CN_NUM}|\\d{1,2})\\s*月\\s*(${CN_NUM}|\\d{1,2})\\s*[日号]?`));
    if (m) {
      const mo = cnToInt(m[1]);
      const dd = cnToInt(m[2]);
      if (Number.isFinite(mo) && mo >= 1 && mo <= 12 && Number.isFinite(dd) && dd >= 1) {
        month = mo;
        day = dd;
        hasDate = true;
      }
    }
  }

  // 11/20、11.19、11-19（不含 2026-11-20 这种带年份的）
  if (!hasDate) {
    m = text.match(/(?:^|[^\d])(\d{1,2})\s*[.\/-]\s*(\d{1,2})(?!\d)(?!\s*[点时])/);
    if (m) {
      const mo = +m[1];
      const dd = +m[2];
      if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
        month = mo;
        day = dd;
        hasDate = true;
      }
    }
  }

  // 下个月 20 号
  if (!hasDate) {
    m = text.match(new RegExp(`(下下个月|下个月|本月|这个月)\\s*(${CN_NUM}|\\d{1,2})\\s*[日号]`));
    if (m) {
      const shift = m[1] === '下下个月' ? 2 : m[1] === '下个月' ? 1 : 0;
      const dd = cnToInt(m[2]);
      if (Number.isFinite(dd) && dd >= 1 && dd <= 31) {
        const anchor = new Date(now.getFullYear(), now.getMonth() + shift, 1);
        month = anchor.getMonth() + 1;
        year = anchor.getFullYear();
        day = Math.min(dd, daysInMonth(anchor.getFullYear(), anchor.getMonth() + 1));
        hasDate = true;
      }
    }
  }

  // 星期 / 周几
  let weekMatched = false;
  if (!hasDate) {
    m = text.match(/(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
    if (m) {
      const target = WEEK_INDEX[m[2]];
      if (target !== undefined) {
        const todayIdx = now.getDay();
        const mondayOffset = todayIdx === 0 ? -6 : 1 - todayIdx;
        const monday = addDays(base, mondayOffset);
        const prefix = m[1] || '';
        const weekShift = prefix === '下下' ? 14 : prefix === '下' ? 7 : 0;
        const dayOffset = target === 0 ? 6 : target - 1;
        let candidate = addDays(monday, weekShift + dayOffset);
        if (!prefix && candidate.getTime() < base.getTime()) {
          candidate = addDays(candidate, 7);
        }
        year = candidate.getFullYear();
        month = candidate.getMonth() + 1;
        day = candidate.getDate();
        hasDate = true;
        weekMatched = true;
      }
    }
  }

  // 今天 / 明天 / 后天 / 昨天 / 今晚 / 明早 ...
  if (!hasDate) {
    const dayWords = [
      [/大后天/, 3],
      [/后天/, 2],
      [/明晚|明儿晚上|明天晚上/, 1],
      [/明早|明天早上|明天上午/, 1],
      [/明天|明日|明儿/, 1],
      [/今晚|今天晚上|今夜/, 0],
      [/今早|今天早上|今天上午/, 0],
      [/今天|今日/, 0],
      [/昨晚|昨天晚上/, -1],
      [/昨天|昨日/, -1],
      [/前天/, -2]
    ];
    for (const [re, offset] of dayWords) {
      if (re.test(text)) {
        const d = addDays(base, offset);
        year = d.getFullYear();
        month = d.getMonth() + 1;
        day = d.getDate();
        hasDate = true;
        break;
      }
    }
  }

  // 只有“月日”没有年份时：默认今年，已过去则算明年
  if (hasDate && year === null) {
    year = now.getFullYear();
    if (!weekMatched) {
      const candidate = new Date(year, month - 1, day);
      if (candidate.getTime() < base.getTime()) year += 1;
    }
  }

  // ---------- 3. 时间 ----------
  const periodMatch = text.match(PERIOD_RE);
  let period = periodMatch ? periodMatch[1] : null;
  if (period) {
    // 只把“今晚/明早”这类合成词归一，傍晚、凌晨、清晨保留原义
    if (period === '今晚' || period === '明晚' || period === '昨晚') period = '晚上';
    else if (period === '今早' || period === '明早') period = '早上';
  }
  let hasTime = false;
  let hour = 0;
  let minute = 0;

  m = text.match(/(\d{1,2})\s*:\s*(\d{1,2})/);
  if (m) {
    const h = +m[1];
    const mi = +m[2];
    if (h <= 23 && mi <= 59) {
      hour = h;
      minute = mi;
      hasTime = true;
    }
  }

  if (!hasTime) {
    m = text.match(new RegExp(`(\\d{1,2}|${CN_NUM})\\s*[点时]\\s*(半|一刻|三刻|(\\d{1,2})\\s*分?)?`));
    if (m) {
      const h = cnToInt(m[1]);
      if (Number.isFinite(h) && h <= 23) {
        hour = h;
        if (m[2] === '半') minute = 30;
        else if (m[2] === '一刻') minute = 15;
        else if (m[2] === '三刻') minute = 45;
        else if (m[3] !== undefined) minute = Math.min(+m[3], 59);
        hasTime = true;
      }
    }
  }

  // 只写“中午”“半夜”也能识别
  if (!hasTime) {
    if (period === '中午') {
      hour = 12;
      hasTime = true;
    } else if (period === '半夜') {
      hour = 0;
      hasTime = true;
    }
  }

  // 上下午修正
  let dayShift = 0;
  if (hasTime && period) {
    if (period === '下午' || period === '傍晚') {
      if (hour < 12) hour += 12;
    } else if (period === '晚上' || period === '夜里' || period === '夜间') {
      if (hour === 12) {
        hour = 0;
        dayShift = 1;
      } else if (hour < 12) {
        hour += 12;
      }
    } else if (period === '中午') {
      if (hour >= 1 && hour <= 5) hour += 12;
    } else if (period === '凌晨' || period === '清晨' || period === '半夜') {
      if (hour === 12) {
        hour = 0;
        dayShift = 1;
      }
    } else if (period === '早上' || period === '早晨' || period === '上午') {
      if (hour === 12) {
        hour = 0;
        dayShift = 1;
      }
    }
  }

  // ---------- 4. 合并 ----------
  if (hasDate) {
    const periodEnd = !hasTime && period ? PERIOD_END[period] : null;
    const dt = hasTime
      ? new Date(year, month - 1, day, hour, minute, 0, 0)
      : periodEnd
        ? new Date(year, month - 1, day, periodEnd[0], periodEnd[1], 0, 0)
        : new Date(year, month - 1, day, 23, 59, 0, 0);
    return { dueAt: hasTime ? addDays(dt, dayShift) : dt, hasDate: true, hasTime };
  }

  if (hasTime) {
    let candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
    candidate = addDays(candidate, dayShift);
    if (candidate.getTime() <= now.getTime()) candidate = addDays(candidate, 1);
    return { dueAt: candidate, hasDate: true, hasTime: true };
  }

  return empty;
}

module.exports = { parseDateTime };
