# English30 学习台界面

2026-11-15 · 首版听力工作台

本轮依用户保存的审美规范改为奶油纸底、墨黑主操作、淡紫 `#C4BBFE` 与青柠 `#D4E73E` 局部强调。长字幕保持白纸表面，卡片底部保留克制的叠纸层次。主界面直接进入练习，不放宣传区、无信息英文眉题、连续打卡数字或尚未计算的进度。中文用设备易读字体，英文字幕用 Georgia；字号和行距优先照顾逐句阅读。

宽屏左侧约 60% 为字幕，右侧约 40% 为题目。窄屏依次显示字幕、题目。点词面板放在右栏首位，避免被 13 道题推到页面底部；题目列表独立滚动，提交入口留在列表外。底部播放器在所有屏幕固定可见，页面按实际播放器高度预留空间。`ui-motion.mjs` 监听 visualViewport：输入键盘出现时收成单行，并移动到可见视口底部；表单不放进固定页面高度内。输入和选择框至少 16px，避免 iPad Safari 输入聚焦自动放大。

练习阶段依次为首听、复盘、复测。首听隐藏字幕与证据；提交后的复盘开放逐词标记；复测再次关掉提示。具体权限与作答状态由 app.mjs 实现，HTML 不内嵌答案。

四类标记：播放位置使用浅紫底色；认识但听不出使用紫灰虚线下划线；不认识使用褐色实线下划线；答案证据使用淡青柠底和边线。颜色之外同时保留下划线样式、题号或文本提示。高亮不改变字宽。

## RubberSegment 复用依据

按 RubberSegment 的原生 DOM 适配机制实现；保留原组件归属与许可，不引入 React 或 Motion 运行时。

采用 FamiliarSegments 的 `stretch=26`、`inset=5`、`radius=28`。保留双边缘测量、190ms 伸展与 150ms 交接、带速度的弹簧落位、3px 轻回正、拖动边界橡皮阻尼、甩动投影、纵向手势取消及键盘切换。胶囊两端是实际数值弹簧，不用固定 translate 假定按钮尺寸。MutationObserver 读取现有 `aria-pressed` 业务状态，ResizeObserver 重测每个按钮；减少动态效果时即时落位。原组件 Motion 库的时间参数换算为受阻尼数值弹簧，目标为同样克制的落位与伸展机制，非逐帧一致承诺。

保留 MIT + Commons Clause 原许可全文于 `web/licenses/rubber-segment.txt`。本移植仅作为 English30 应用的一部分，不将组件本身独立再分发。

## 与应用代码的接口

所有功能元素使用 root 约定的稳定 DOM ID。动态字幕建议使用 `.sentence[data-sentence-id]`、`.word[data-word-id]`。当前句 `.is-current`，当前词 `.is-playing`，点选词 `.is-selected`，个人标记 `.is-heard`／`.is-unknown`，答案证据 `.is-evidence`。CSS 也兼容 `.active`、`.current`、`.heard`、`.unknown`、`.evidence` 等直观别名。

题目使用 `.question-card`、`.question-label`、`.question-input`、`.question-feedback`、`.evidence-link`，结果 `.is-correct`／`.is-incorrect`。标记清单使用 `.mark-item`，空态 `.empty-state`／`.empty-copy`，批改摘要 `.result-summary`。按钮的 `aria-pressed="true"` 会显示选中样式；`hidden` 控制条件区域。

表单及工具栏按钮至少 44px 高。字幕内的单词保持自然文本流，触控行高高于 44px；短词宽度由词本身决定，实际 iPad 点击精度须验收。保留系统焦点轮廓、键盘跳到题目、状态 live region、减少动画设置。音频播放更新不应通过 live region 逐词朗读。

## 交付边界

纯 HTML/CSS 与原生 JavaScript，无外部字体、图片或运行时依赖。SVG 为功能图标。manifest 只提供安装元数据，不代表已经实现离线缓存。已建立响应式、visualViewport 键盘适配及减少动态效果分支；真实 iPad 横竖屏、软键盘、播放中断仍需设备验证，浏览器缩放或视口模拟不能替代。
