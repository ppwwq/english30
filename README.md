# English30 · 英文训练台

面向 iPad 和电脑的 HKDSE 英文练习网站，围绕原卷精听、逐词字幕、题目原音证据、阅读和写句练习。

**[打开公开网站](https://english30-listening.philipwwq.workers.dev/#listening)** · 无需登录

## 听力练习

「听力练习」默认进入 **Past Paper 原卷**，可直接选择年份、正式／Practice／Sample、Part 和 Task。题页、字幕和原音在同一界面联动；「分段精练」保留已有短篇作答、反馈和复测流程。原卷库仍可浏览其他 Paper 的题卷、Data File、原稿和评分参考。

- 覆盖 2012–2025 年及 Practice 的 15 套完整可播放录音、150 个 Task 入口。
- 129 份原件、4,675 页；按原始文件身份保留来源，并区分题卷、原稿和评分材料。
- 逐词字幕、点词重听、原句／Task 循环、范围证据播放、跨音频分段拖动，以及复习标记跟随。
- 低置信词只提供整句定位；没有可靠证据片段的题号明确标为待核实。
- 2012 Sample 原卷与原稿可浏览，但提供的录音不匹配，因此不提供虚构字幕或错误录音。

练习以 A+B1 为重点。B2 材料保留作参考。阅读、写句、原音听写、B1 综合练习及备份功能也可使用。训练计划是最后一个可选入口，不自动安排。

## 学习纪录

点击「保存本次学习纪录」才正式保存；数据只在当前设备的当前浏览器中，没有云端账号、自动同步或后台收集。可在「待复习与备份」导出完整备份，再在其他设备或网址导入。清除网站数据前应自行备份。

题库的自动比对与声学时间轴不等于逐字人工听校。系统不会把自由表达自动换算为官方 DSE 分数。iPad 尺寸和触摸交互已用浏览器模拟检查，实体 iPad Safari 尚未完整实机验收。

## 本地运行

需要 Node.js 22 或更新版本。网页使用原生 HTML、CSS 和 JavaScript，无前端框架运行时。

```sh
npm ci
npm run assets:download
npm start
```

打开 <http://127.0.0.1:4173>。

Git 仓库包含源码、字幕、题目数据和媒体清单，音频与试卷图片不放进 Git 历史。`assets:download` 从上述公开站点恢复约 **1.2 GB / 4,840 个媒体文件**，逐个校验大小与 SHA-256。中断后重新运行会复用已完整校验的文件，未完成的文件重新下载；不会从任意来源执行代码。站点若停止提供原文件，恢复会明确失败，不会把错误内容当成功。

媒体恢复完成后，网站和全库测试可使用本地文件。没有自动离线缓存或仅凭 MP3 自动生成字幕的服务。

## 检查

```sh
npm run check
npm test
```

首次运行浏览器检查时安装 Playwright 和 Chromium，然后保持 `npm start` 运行：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:pastpaper
npm run test:papers
npm run test:player
npm run test:platform
```

可用 `TEST_URL` 检查另一个部署网址，用 `PLAYWRIGHT_PACKAGE` 和 `CHROMIUM_EXECUTABLE` 指定已有浏览器环境。浏览器测试使用独立上下文，不应指向含真实学习纪录的个人浏览器配置。测试产物放在 `tests/artifacts/`，不进入 Git。

## Cloudflare 发布

先恢复媒体并通过本地检查，再使用自己的 Cloudflare 账号：

```sh
npx --yes wrangler@4.129.0 login
npm run check:cloudflare
npm run deploy:cloudflare
```

`wrangler.jsonc` 不包含账号 ID、密钥或数据库绑定。发布到自己的账号前可改 Worker 名称。静态资源与小型 Worker 分开上传；后续只传内容变更的资源。音频由 Worker 补充真实 HTTP Range／HEAD 支持，以兼容 Safari 的媒体探测与拖动。

## 来源与许可

页面保留试卷、原音、原稿及评分材料的来源说明。媒体和试题的权利属于各自权利人，代码仓库公开不代表额外授予这些材料的再分发许可。

弹性导航的 RubberSegment 适配保留 [MIT + Commons Clause 原许可](web/licenses/rubber-segment.txt)。本项目没有将全部源码和第三方材料统一声明为 MIT；使用相关部分时应分别核对其许可和来源。
