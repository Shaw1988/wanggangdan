'use strict';

const assert = require('assert');
const { parseDateTime } = require('../electron/parser');

const NOW = new Date(2026, 10, 19, 10, 0, 0, 0); // 2026-11-19 周四 10:00

const cases = [
  // [输入, 期望的截止时间字符串, 是否有时间]
  ['明天下午3点 交报告', '2026-11-20 15:00', true],
  ['今天18:30健身', '2026-11-19 18:30', true],
  ['今晚八点半看电影', '2026-11-19 20:30', true],
  ['中午12点半吃饭', '2026-11-19 12:30', true],
  ['晚上8点开周会', '2026-11-19 20:00', true],
  ['周五交周报', '2026-11-20 23:59', false],
  ['下周一开会', '2026-11-23 23:59', false],
  ['下周三下午两点评审', '2026-11-25 14:00', true],
  ['11月25日 10点体检', '2026-11-25 10:00', true],
  ['十一月二十号交材料', '2026-11-20 23:59', false],
  ['12月1日交材料', '2026-12-01 23:59', false],
  ['1月5日回访', '2027-01-05 23:59', false],
  ['2027-01-03 08:00 出发', '2027-01-03 08:00', true],
  ['11/20 提交报表', '2026-11-20 23:59', false],
  ['3天后回访客户', '2026-11-22 10:00', false],
  ['2小时后打电话', '2026-11-19 12:00', true],
  ['半小时后喝水', '2026-11-19 10:30', true],
  ['15分钟后出门', '2026-11-19 10:15', true],
  ['后天上午十点', '2026-11-21 10:00', true],
  ['下午三点一刻', '2026-11-19 15:15', true],
  ['凌晨12点抢票', '2026-11-20 00:00', true],
  ['9点开会', '2026-11-20 09:00', true],
  ['今晚', '2026-11-19 23:59', false],
  ['下个月3号交房租', '2026-12-03 23:59', false],
  ['星期天休息', '2026-11-22 23:59', false],
  ['这周三的日报', '2026-11-18 23:59', false],
  ['买菜', null, false],
  ['写一份周报', null, false]
];

function fmt(date) {
  if (!date) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

let failed = 0;
for (const [input, expected, expectTime] of cases) {
  const result = parseDateTime(input, NOW);
  const actual = fmt(result.dueAt);
  try {
    assert.strictEqual(actual, expected, '时间不符');
    assert.strictEqual(result.hasTime, expectTime, 'hasTime 不符');
    console.log(`PASS  ${input}  ->  ${actual}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${input}  ->  ${actual} (期望 ${expected}, hasTime=${expectTime})`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
