# 实现任务清单

> 说明：本次为对工作区已有增量改动的回溯性提案，实现已落于 `app.js` / `.gitignore` 未提交改动中，任务标记为已完成。验收时对照 `specs/photo-render-layering/spec.md` 的 Scenario 逐条确认。

## 1. 常量与状态
- [x] 1.1 新增渲染常量 `ZOOM_THUMB=14`、`VIEWPORT_PAD=0.5`、`RENDER_BATCH=60`、`LOAD_BATCH=200`
- [x] 1.2 新增渲染层状态 `thumbLayer`、`dotLayer`、`dotRenderer`、`renderRaf`、`scaleRaf`、`dotsBuilt`、`playerThumb`

## 2. 解耦坐标与 marker 创建
- [x] 2.1 拆 `addMarker` 为 `preparePhoto`（仅算 gLng/gLat）
- [x] 2.2 新增 `createThumbMarker(p)`：创建 divIcon 缩略图 marker，绑定点击→openViewer
- [x] 2.3 新增 `createDotMarker(p)`：创建 circleMarker（共享 dotRenderer），绑定点击→openViewer
- [x] 2.4 新增 `disposeThumbMarker(p)`：清空 marker/el 引用
- [x] 2.5 入库路径（`loadDbBytes` / `importFiles`）改调 `preparePhoto`，不再创建 marker

## 3. 渲染调度
- [x] 3.1 `initMap` 中创建 `thumbLayer=L.layerGroup()`、`dotLayer=L.layerGroup()`、`dotRenderer=L.canvas({padding:0.5})`
- [x] 3.2 `zoomend`/`moveend` 绑定 `scheduleRender`（含 `updateAllScales`）
- [x] 3.3 实现 `scheduleRender`：rAF 防抖合并多次触发
- [x] 3.4 实现 `renderVisible`：高缩放飞缩略图+视口裁剪+分批创建；低缩放飞圆点全量
- [x] 3.5 高缩放：`bounds.pad(VIEWPORT_PAD)` 外的 marker 移除并 `disposeThumbMarker`；内的分批 `createThumbMarker`+`thumbLayer.addLayer`
- [x] 3.6 低缩放：清空 thumbLayer 并 dispose 全部；为缺 dot 的照片创建 circleMarker 加入 dotLayer
- [x] 3.7 入库/加载完成路径显式调 `scheduleRender`（同区域增量加载 moveend 不触发时也能刷新）

## 4. 数据库分批加载
- [x] 4.1 `loadDbBytes` 改为 `chunk(start)` 递归：每批 `LOAD_BATCH` 行，批间 `setTimeout(resolve, 0)` 让出
- [x] 4.2 每批后调 `progress('正在加载数据库', end, rows.length, '已解析 N 张')` 更新进度
- [x] 4.3 返回 `stat {added, skipped, noGeo, newOnes}` 与原结构兼容

## 5. rAF 防抖
- [x] 5.1 `updateAllScales` 用 `scaleRaf` 合并：连续触发只在下一帧执行一次
- [x] 5.2 `scheduleRender` 用 `renderRaf` 合并

## 6. 播放适配
- [x] 6.1 实现 `ensurePlayerMarker(p)`：无 marker 时创建；高缩放进 thumbLayer，低缩放 `addTo(map)` 并记 `playerThumb`
- [x] 6.2 实现 `releasePlayerMarker(p)`：仅销毁 dot 模式下的临时 `playerThumb`
- [x] 6.3 实现 `syncPlayerThumb`：dot 模式下为当前播放照片同步临时缩略图（高亮+抖动+ZIndex）
- [x] 6.4 实现 `clearPlayerThumb`：销毁临时 marker 并清理 active/shake 类
- [x] 6.5 `renderVisible` 高缩放分支调 `clearPlayerThumb`；低缩放分支调 `syncPlayerThumb`
- [x] 6.6 `tickPlay` 改用 `ensurePlayerMarker` + 上一张 `releasePlayerMarker`
- [x] 6.7 `stopPlay` 调 `clearPlayerThumb` 清理

## 7. 其他
- [x] 7.1 `.gitignore` 新增 `*.zip` 忽略规则

## 8. 验收
- [ ] 8.1 低缩放（<14）：照片点位显示为蓝色圆点，点击圆点打开大图查看器
- [ ] 8.2 高缩放（≥14）：照片点位显示为缩略图，平移时视口外逐渐消失、视口内逐渐出现
- [ ] 8.3 缩放跨 14 级：圆点层与缩略图层互斥切换，无残留
- [ ] 8.4 导入大数据集（>1000 张）：进度条实时更新，UI 不冻结
- [ ] 8.5 低缩放下播放：当前照片以缩略图高亮显示（抖动+放大），切下一张时上一张临时缩略图消失
- [ ] 8.6 高缩放下播放：当前照片缩略图高亮，视口外被裁剪时仍能补建临时 marker
