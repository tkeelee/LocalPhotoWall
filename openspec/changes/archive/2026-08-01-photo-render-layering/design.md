## Context
原实现 `addMarker(p)` 在照片入库时立即创建 divIcon 缩略图 marker 并 `addTo(map)`，对所有照片无差别全量渲染。照片点位缩放跟随地图缩放（`--s` CSS 变量），`updateAllScales` 每次遍历全部 `photos`。这套机制在百张以内可用，上千张时首屏阻塞、平移掉帧。数据库导入 `loadDbBytes` 同步遍历全部行，无让出，导致主线程长时间冻结、进度条不更新。

既有约束：照片点位位置（GCJ02 纠偏）、缩略图内容、播放交互（抖动+放大+ZIndex）均为对外行为契约，本次优化不得改变。

## Goals / Non-Goals
**Goals:**
- 大数据集（数千张）下首屏渲染与平移/缩放保持流畅
- 数据库导入过程 UI 不冻结，进度可观测
- 不改变点位位置准确性、缩略图内容、播放交互行为
- 复用 Leaflet 内置能力，不引入新依赖

**Non-Goals:**
- 不实现 Web Worker 异步解析（保持单线程 ES5 兼容）
- 不改变照片数据结构与存储格式
- 不优化瓦片层加载（仅优化照片点位渲染）
- 不实现虚拟列表/聚类（cluster）——视口裁剪已足够

## Decisions

### 决策 1：按缩放级别二选一渲染模式，而非同屏共存
**选择**：定义 `ZOOM_THUMB=14`，`>=` 用 divIcon 缩略图，`<` 用 Canvas 圆点；切换时清空对方图层。
**理由**：低缩放下视野内点位密集，缩略图互相重叠且 DOM 节点爆炸；圆点用单一 Canvas renderer 绘制数千点性能极佳。高缩放下视野内点位稀疏，缩略图能展示照片内容才有意义。同屏共存会使低缩放仍背 DOM 负担，违背分层初衷。
**备选**：始终用缩略图 + 视口裁剪——已否决，低缩放视野内仍有数千点，DOM 节点与重排开销大。
**备选**：始终用圆点——已否决，高缩放失去照片内容信息，体验回退。

### 决策 2：视口外扩裁剪而非全量隐藏
**选择**：`map.getBounds().pad(VIEWPORT_PAD=0.5)` 作为可见边界，边界外 marker 移除并销毁 DOM 引用。
**理由**：纯视口裁剪在平移时会立即触发增删，边缘抖动；外扩 0.5（即上下左右各多出半个视口）让平移小幅度时不触发重建，覆盖大多数连续平移场景。外扩过大会降低裁剪收益。
**备选**：纯视口裁剪（pad=0）——已否决，平移时频繁增删。
**备选**：超大外扩（pad=1+）——已否决，接近全量渲染失去意义。

### 决策 3：分批创建用 requestAnimationFrame，而非 setTimeout
**选择**：高缩放新增 marker 时，每帧创建 `RENDER_BATCH=60` 个，未完成则下一帧继续。
**理由**：rAF 与浏览器渲染节奏对齐，每帧留出时间给布局与绘制；setTimeout(0) 实际最小 4ms 且不与渲染同步。60 个/帧在主流设备上既能推进又不出帧。
**备选**：一次性创建——已否决，大数据集首帧卡死。
**备选**：setTimeout 分批——已否决，节奏不如 rAF 顺滑。

### 决策 4：数据库分批加载用 setTimeout(0) 让出，而非 rAF
**选择**：`loadDbBytes` 按 `LOAD_BATCH=200` 行分块，块间 `setTimeout(resolve, 0)` 让出主线程，更新进度条。
**理由**：数据库解析是纯计算，不涉及渲染，rAF 会延迟到下一帧才继续（拖慢总时长）；setTimeout(0) 让出后立即继续，既能更新 UI 又不显著拉长总时间。200 行/批在主流数据集下进度条更新顺滑。
**备选**：rAF 分批——已否决，总时长拉长。
**备选**：同步全量——已否决，主线程冻结。

### 决策 5：解耦 `preparePhoto` 与 `createThumbMarker`
**选择**：原 `addMarker` 拆为：`preparePhoto(p)` 仅算 `gLng/gLat`；`createThumbMarker(p)` 创建 divIcon marker；`createDotMarker(p)` 创建 circleMarker。入库时只调 `preparePhoto`，marker 由 `renderVisible` 按需创建。
**理由**：分层渲染下 marker 创建/销毁是高频操作，必须与「照片入库」解耦；入库时算坐标是 O(1) 廉价操作，可全量执行。
**备选**：保留 `addMarker` 全量创建——已否决，违背分层目标。

### 决策 6：播放低缩放临时缩略图用独立 `playerThumb`
**选择**：低缩放下当前播放照片无 `el`（圆点模式），通过 `syncPlayerThumb` 为其单独创建一个缩略图 marker `addTo(map)`，存于 `playerThumb`；切到下一张或停止时 `clearPlayerThumb` 销毁。高缩放下若该照片 marker 已在 thumbLayer 则复用，否则 `ensurePlayerMarker` 临时补建。
**理由**：播放交互契约要求当前照片有缩略图高亮（抖动+放大），低缩放圆点模式无法满足；为整层切换会破坏低缩放性能优势。独立临时 marker 是最小侵入方案。
**备选**：播放时整体切到缩略图模式——已否决，破坏低缩放性能与视觉一致性。
**备选**：低缩放下不做缩略图高亮——已否决，违反播放交互契约。

### 决策 7：rAF 防抖 `updateAllScales` 与 `scheduleRender`
**选择**：`zoomend` 触发的 `updateAllScales` 与 `moveend`/`zoomend` 触发的 `renderVisible` 均经 rAF 合并；连续事件只会在下一帧执行一次。
**理由**：Leaflet 在快速平移/缩放时会连续触发事件，全量遍历 `photos` 改 `--s` 或重建 marker 会重复劳动；rAF 合并保证每帧最多一次执行。
**备选**：直接执行——已否决，连续事件下重复计算。

## Risks / Trade-offs
- **[视口裁剪边界空白]** 快速平移超出外扩范围时，新进入区域短暂无 marker，下一帧 rAF 补建 → 缓解：VIEWPORT_PAD=0.5 覆盖多数连续平移；可接受瞬时空白
- **[圆点模式失去照片内容]** 低缩放下用户看不到照片缩略图 → 接受，低缩放本就是宏观浏览；点击圆点仍打开大图查看器；放大到 ZOOM_THUMB 即恢复缩略图
- **[分批创建首帧不全]** 高缩放首次进入时视口内 marker 分多帧出现 → 接受，60/帧下 1000 点约 17 帧（<300ms）即齐
- **[播放切层抖动]** 播放中触发缩放跨 ZOOM_THUMB 边界时，`playerThumb` 与 thumbLayer 临时 marker 切换可能闪烁 → 缓解：`ensurePlayerMarker`/`releasePlayerMarker` 配合 `clearPlayerThumb` 处理状态迁移；可接受
- **[数据库分批拉长总时长]** setTimeout 让出会增加总耗时（每批 ~4ms 让出） → 接受，10000 行约 50 批 ×4ms = 200ms 额外，远小于冻结带来的体验损失

## Migration Plan
本次为渲染机制重构，无数据迁移。已写入的数据库与照片点位不受影响：`preparePhoto` 计算的 `gLng/gLat` 与原 `addMarker` 计算结果一致；marker 创建/销毁完全在内存中，不影响持久化数据。

## Open Questions
- 视口裁剪的 VIEWPORT_PAD 是否需要按设备性能动态调整？——可延后，当前 0.5 在 3000 点数据集下表现良好
- 是否需要在低缩放圆点上也做视口裁剪？——目前 circleMarker 用单一 Canvas renderer，全量绘制性能已足够，暂不需要
