# 实现任务清单

> 说明：本次扩展既有 `photo-playback` 能力，含三类改动 —— ①时间刻度线（ADDED）、②播放缩略图 / 区间外点位开关（ADDED）、③播放区间点位视觉区分升级为已播 / 未播 / 区间外三态（MODIFIED）。实现完成后对照 `specs/photo-playback/spec.md` 新增 / 修改 Scenario 逐条验收。

## 1. 时间刻度线 DOM 与样式
- [x] 1.1 `index.html` 在 `#playHud` 后新增 `#hudTimeline` 容器，含 `#htLabels`（年份/月份标签）、`#htTicks`（刻度线）、`#htPlayhead`（当前位置游标）、`#htHit`（拖动命中层）
- [x] 1.2 CSS：`#hudTimeline` 由 `positionTimelineAboveHud()` 动态定位到 `#playHud` 上方并左右缩进到 dock 之外，高度 34px，`z-index:590`（低于 `#playHud` 620 与 docks 600），`pointer-events:auto`，背景跟随 `--hud-bg` 翻转
- [x] 1.3 `.ht-tick` / `.ht-label` 使用 `var(--ink)` + 与玻璃背板同色的 `text-shadow`，在明 / 暗底图瓦片上均可读；年 / 月刻度区分高度（年 12px、月 6px）

## 2. 刻度生成与渲染
- [x] 2.1 `app.js` 新增 `renderTimeline()`：根据 `player.list` 起止时间构建刻度集合，写入 `#htTicks` 与 `#htLabels`，返回是否成功渲染
- [x] 2.2 刻度算法：始终同时绘制年刻度与月刻度；月起从 `startTs` 所在月 1 日逐月推进到 `endTs` 所在月；年刻度在每年 1 月 1 日位置绘制
- [x] 2.3 刻度位置 = `(ts - startTs) / (endTs - startTs) * 100%`，限制在 `[0, 100]`
- [x] 2.4 强制两端年份对齐真实区间：最左标签为起始年、最右标签为结束年（即使起点不在 1 月）
- [x] 2.5 跨度 ≤ 180 天时额外为月刻度添加月份文字标签（如 `3月`）
- [x] 2.6 `startPlay` 末尾 `tickPlay()` 之前调用 `renderTimeline()` + `positionTimelineAboveHud()`，成功则 `show(hudTimeline)`
- [x] 2.7 `stopPlay` 末尾 `hide(hudTimeline)`，播放列表清空时一并隐藏
- [x] 2.8 边缘场景：`list.length < 2` 或 `endTs <= startTs` 时 `renderTimeline()` 返回 false，整条隐藏

## 3. 游标与进度条同步
- [x] 3.1 `app.js` 新增 `updateTimelinePlayhead(idx)`：设置 `#htPlayhead.style.left = (idx / max(1, list.length-1) * 100) + '%'`
- [x] 3.2 `tickPlay` 中更新 `#hudBar` / `#hudSeek.value` 后调用 `updateTimelinePlayhead(player.idx)`
- [x] 3.3 `#hudSeek` 的 `input` 与 `change` 回调中同样调用 `updateTimelinePlayhead(idx)`

## 4. 刻度线拖动跳转
- [x] 4.1 `#htHit` 监听 `pointerdown`：切换到拖动态并 `setPointerCapture`
- [x] 4.2 `pointermove`（按下后）：根据鼠标 X 计算 `idx`，`clearTimeout(player.timer)` 暂停自动前进并调用 `previewAt(idx)` 实时预览（同步 `#hudName` / `#hudTime` / `#hudBar` / `#hudSeek.value` / 游标）
- [x] 4.3 `pointerup` / `pointercancel`：调用 `commitAt(idx)` —— 清理当前高亮 → `player.idx = idx` → `tickPlay()` 重新高亮并按当前速度 / 暂停状态调度
- [x] 4.4 拖动期间 `clearTimeout(player.timer)`，避免自动推进覆盖手动操作

## 5. 播放缩略图开关
- [x] 5.1 `index.html` 在播放设置弹窗新增「缩略图」复选框 `#playThumb`，默认 `checked`
- [x] 5.2 `startPlay` 读取 `player.showThumb = $('playThumb').checked`，一次性固定到本次播放实例
- [x] 5.3 `renderVisible()` 在 `showThumb=false` 时强制走 dot 模式（不创建缩略图 marker），`stopPlay` 后按缩放级别恢复
- [x] 5.4 `tickPlay` 在 `showThumb=false` 时只为当前 dot 高亮（放大 + 亮橙色 `#ff6b35` radius 8），不创建临时缩略图 marker

## 6. 播放区间外点位开关
- [x] 6.1 `index.html` 在播放设置弹窗新增「区间外点位」复选框 `#playOutRange`，默认不勾选
- [x] 6.2 `startPlay` 读取 `player.showOutRange = $('playOutRange').checked`，一次性固定到本次播放实例
- [x] 6.3 `renderVisible()` 在 `showOutRange=false` 时跳过区间外点位（不加入图层，已加入的移除），`showOutRange=true` 时按原有橙色降级行为显示
- [x] 6.4 `applyPlayStyles()` 在 `!inPlay && !player.showOutRange` 时跳过样式计算
- [x] 6.5 `stopPlay` 后 `renderVisible()` 恢复所有点位可见性

## 7. 播放区间点位视觉区分升级为三态
- [x] 7.1 `startPlay` 初始化 `player.playedHashes = {}` 与 `player.lastIdx = -1`
- [x] 7.2 `applyPlayStyles()` 按三态染色：区间外橙 `#ff9500`、区间内未播蓝 `#2b6cff`、区间内已播绿 `#34c759`；缩略图模式叠加 `pm-out` / `pm-played` class
- [x] 7.3 `tickPlay` 顺序前进（`idx === lastIdx + 1`）时仅把上一张标记为已播并即时染色
- [x] 7.4 `tickPlay` 跳转前进 / 回退时按当前 `idx` 重建 `playedHashes` 并调用 `applyPlayStyles()` 全量重染
- [x] 7.5 `clearPlayStyles()` 停止播放时复位圆点半径与颜色、移除 `pm-out` / `pm-played` class

## 8. 验收
- [x] 8.1 开始播放后 HUD 上方出现铺满横向宽度的时间刻度线，年份标签在年份切换处可见，两端强制标注起始 / 结束年
- [x] 8.2 自动播放时游标实时跟随当前播放位置
- [x] 8.3 拖动 `#hudSeek` → 刻度线游标同步移动；反之在刻度线上点按 / 拖动 → `#hudSeek` 与 `#hudBar` 同步更新、播放跳转到对应位置
- [x] 8.4 停止播放后刻度线整条隐藏
- [x] 8.5 跨度 < 1 个月、跨度 ≥ 5 年等边缘场景按设计文档表格正确降级
- [x] 8.6 关闭「缩略图」开关后播放走圆点三态：已播绿、未播蓝、当前活跃放大亮橙
- [x] 8.7 默认隐藏区间外点位；勾选「区间外点位」后以橙色降级显示
- [x] 8.8 跳转（进度条 / 时间刻度）后已播集合按新位置重建，颜色同步刷新
- [x] 8.9 `node --check app.js` 语法通过
