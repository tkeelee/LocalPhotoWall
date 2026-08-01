## Why
照片数量增长后，原实现「一次性为所有照片创建 divIcon 缩略图 marker 并加入地图」出现明显卡顿：上千张照片时首屏渲染阻塞主线程数秒，平移/缩放时所有 marker 重新布局同样掉帧；数据库导入大数据集时主线程长时间无响应，进度条无法更新。需要在不改变对外行为契约（点位位置、缩略图内容、播放交互）的前提下，通过分层渲染与分批处理让大数据集下界面保持响应。

## What Changes
- 渲染分层：按缩放级别切换两种渲染模式
  - 高缩放（≥ ZOOM_THUMB）：用 divIcon 缩略图 marker，按视口外扩裁剪，仅渲染可见区域；视口外 marker 销毁释放 DOM
  - 低缩放（< ZOOM_THUMB）：用共享 Canvas renderer 的 circleMarker 圆点，单画布绘制数千点无压力
- 视口裁剪：`moveend`/`zoomend` 后按 `map.getBounds().pad(VIEWPORT_PAD)` 判定 marker 进出，避免平移时频繁增删
- 分批创建：高缩放下每帧批量创建 `RENDER_BATCH` 个缩略图 marker，避免单帧卡顿
- 数据库分批加载：`loadDbBytes` 改为按 `LOAD_BATCH` 行分块处理，批间让出主线程，进度条实时更新
- rAF 防抖：`updateAllScales` 与 `scheduleRender` 均用 `requestAnimationFrame` 合并多次事件触发
- 解耦坐标计算与 marker 创建：原 `addMarker` 拆为 `preparePhoto`（仅算 GCJ02 坐标）+ `createThumbMarker`/`createDotMarker`（按需创建）
- 播放适配：低缩放下为当前播放照片叠加临时缩略图 marker（`playerThumb`），高缩放下复用 thumbLayer 内既有 marker 或临时补建
- `.gitignore` 新增 `*.zip` 忽略规则

## Capabilities
### New Capabilities
- `photo-render-layering`: 照片点位按缩放级别分层渲染，覆盖高/低缩放渲染模式、视口裁剪、分批创建、分批数据库加载、播放时低缩放临时缩略图等对外可观察行为

### Modified Capabilities
<!-- 本次为项目新增的第 2 个 capability，与既有 overseas-basemap 互不依赖，无修改项 -->

## Impact
- **代码**：`app.js`（新增渲染层状态与调度、重构 addMarker、loadDbBytes 分块、播放 marker 管理、rAF 防抖）、`.gitignore`（新增 `*.zip`）
- **依赖**：无新增第三方库，复用 Leaflet 内置 `L.canvas` renderer 与 `L.circleMarker`
- **行为**：
  - 视觉：低缩放下照片点位由缩略图变为蓝色圆点；高缩放下保持缩略图，但平移时视口外缩略图消失、视口内逐渐出现
  - 性能：大数据集首屏与平移流畅度显著提升；数据库导入过程进度可观测
  - 播放：低缩放下当前播放照片仍以缩略图高亮显示，交互不变
- **风险**：视口裁剪边界（VIEWPORT_PAD=0.5）过小可能导致快速平移时短暂空白；过大则失去裁剪收益。当前 0.5 为经验值
