# 王钢蛋

一个赖在桌角的桌面 todolist 小玩意儿。Windows / Electron，透明无边框，不抢焦点、不占任务栏。

![王钢蛋](docs/pet.png)

鼠标放上去，卷轴自己展开；人一走，它就悄悄收起来。

![待办卷轴](docs/panel.png)

## 功能

- 悬停展开卷轴式待办面板，移开自动收起；面板贴近屏幕边缘时自动翻到另一侧，不挡本体
- 口语化输入自动识别时限：「明天下午三点」「11.19 上午 10 点」「今天晚上」
- 未完成按紧急程度排序：今明两天与逾期置顶，橙色 / 暗红色竖线提示
- 点击待办文字原地修改，Enter 保存，Esc 取消
- 完成后显示精确到分钟的完成时间；超过一个月的自动按月归档
- 大 / 中 / 小三档尺寸，卷轴尺寸保持不变；拖动位置会记住
- 可在「王钢蛋本体」和数字时钟（时间、日期、星期、农历）之间切换
- 托盘菜单：大小、形态、开机自启动、导出待办、关于
- 导出 Markdown，每条带创建 / 截止 / 完成时间

## 运行

需要 Node.js 18+，Windows 10 / 11。

```bash
npm install
npm start
```

打包安装程序：

```bash
npm run build
```

产物输出到 `dist/`。

## 目录

```text
electron/   主进程、待办存储、中文时间解析、IPC
renderer/   角色窗口、待办面板、关于窗口
assets/     角色图片与托盘图标
scripts/    时间解析与排序的测试脚本
```

## 测试

```bash
npm run test:parser
node scripts/test-sort.js
```

## 作者

Shaw1988 & TRAE

<https://github.com/Shaw1988>

注：我 P 都不懂，都是 TRAE 做的~

## License

MIT
