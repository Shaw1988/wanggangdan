// 排序逻辑单元测试：用临时目录模拟 userData，不触碰真实待办数据
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const dir = path.join(os.tmpdir(), `wg-sort-test-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => dir } };
  }
  return origLoad.call(this, request, parent, isMain);
};

const at = (s) => new Date(s).getTime();
// 创建时间用真实量级，否则 store 启动时按创建时间重解析会跑到 1970 年
const T0 = at('2026-11-19T09:00:00');
const todos = [
  { id: 'A', text: '后天交材料', createdAt: T0 + 1000, dueAt: at('2026-11-21T10:00:00'), hasTime: true, completed: false },
  { id: 'B', text: '买牛奶', createdAt: T0 + 2000, dueAt: null, hasTime: false, completed: false },
  { id: 'C', text: '今天18点开会', createdAt: T0 + 3000, dueAt: at('2026-11-19T18:00:00'), hasTime: true, completed: false },
  { id: 'D', text: '今天12点吃药', createdAt: T0 + 4000, dueAt: at('2026-11-19T12:00:00'), hasTime: true, completed: false },
  { id: 'E', text: '明天9点体检', createdAt: T0 + 5000, dueAt: at('2026-11-20T09:00:00'), hasTime: true, completed: false },
  { id: 'F', text: '昨天交房租', createdAt: T0 + 6000, dueAt: at('2026-11-18T09:00:00'), hasTime: true, completed: false },
  { id: 'G', text: '已完成的事', createdAt: T0 + 7000, dueAt: null, hasTime: false, completed: true, completedAt: 100 },
  { id: 'H', text: '刚勾掉的事', createdAt: T0 + 8000, dueAt: null, hasTime: false, completed: true, completedAt: 200 }
];
fs.writeFileSync(path.join(dir, 'todos.json'), JSON.stringify({ version: 1, todos }), 'utf8');

const store = require('../electron/store');

const now = new Date('2026-11-19T10:00:00');
const order = store.sortedTodos(now).map((t) => t.id);
const expect = ['F', 'D', 'C', 'E', 'B', 'A', 'H', 'G'];

let pass = 0;
let total = 0;
function check(name, cond) {
  total++;
  if (cond) {
    pass++;
    console.log('  ok  ', name);
  } else {
    console.log('  FAIL', name);
    process.exitCode = 1;
  }
}

console.log('排序结果:', order.join(' → '));
check('逾期/今天/明天 置顶且按时间升序，其余按创建倒序，已完成置底', order.join() === expect.join());
check('无时间项目：新建的在最上面', order.indexOf('B') < order.indexOf('A'));
check('后天及以后的项目排到无时间项目之后', order.indexOf('A') > order.indexOf('E'));
check('已完成：最新勾选的排在最上面，且整体在未完成之后', order.slice(-2).join() === 'H,G');

// 编辑后按修改时间重排
store.update('A', '后天交材料（改过）');
const after = store.sortedTodos(now).map((t) => t.id);
check('修改过的项目排到同类最前面', after.indexOf('A') < after.indexOf('B'));

// 解析器回归
const { parseDateTime } = require('../electron/parser');
const p1 = parseDateTime('明天上午10点开周会', now);
check('解析“明天上午10点”', p1.dueAt && p1.dueAt.getTime() === at('2026-11-20T10:00:00'));
const p2 = parseDateTime('买牛奶', now);
check('无时间任务 dueAt 为空', p2.dueAt === null && p2.hasTime === false);
const p3 = parseDateTime('今天上午报送资料', new Date('2026-11-19T20:00:00'));
check(
  '“今天上午”过了中午算逾期',
  !!p3.dueAt && p3.dueAt.getTime() === at('2026-11-19T12:00:00')
);
const p4 = parseDateTime('11.19上午10点报送资料', now);
check('识别 11.19 这种日期写法', !!p4.dueAt && p4.dueAt.getTime() === at('2026-11-19T10:00:00'));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n通过 ${pass}/${total}`);
