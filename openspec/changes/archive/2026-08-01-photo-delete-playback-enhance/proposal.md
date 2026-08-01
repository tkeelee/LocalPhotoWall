## Why
原照片墙只支持导入与加载，缺少单张删除入口：误导入或不再需要的照片只能通过重建数据库解决。播放体验也存在多处断点：固定 1× 速度无法快速浏览长区间；进度条仅作视觉展示不可拖动，无法跳转或回看；播放期间全图所有点位高亮一致，难以区分本次播放范围；每次打开播放设置弹窗都重置为全时间范围，反复选择同一区间繁琐。本次改动补齐删除能力，并对播放交互做四处增强，使照片墙在巡检与回放场景下更可用。

## What Changes
- 照片删除
  - 大图查看器右上角新增纯图标删除按钮（垃圾桶 SVG，无文字）
  - 点击触发确认弹窗：文案「将立即从照片墙数据库文件内删除，切不可恢复，是否继续？」
  - 「是」：从数据库 `DELETE FROM photos WHERE hash=?`、移除地图 marker（缩略图与圆点）、从内存 `photos`/`hashSet` 清除、若删除项在播放列表中则同步清理或停止播放、关闭查看器、立即 `saveData()` 持久化到磁盘
  - 「否」：仅关闭确认弹窗，返回查看器
  - 删除按钮点击 `stopPropagation`，不触发查看器 dismiss
- 播放速度实时调整
  - HUD 新增 `<select>` 速度选择器，档位 0.5× / 1× / 2× / 4× / 8×
  - `change` 事件立即更新 `player.speed`，并 `clearTimeout` + 按新速度重排当前等待的 `setTimeout`，无需等下一帧才生效
  - 暂停状态下变更速度也生效，恢复播放时按新速度调度
- 进度条拖动 seek
  - 在原视觉进度条上叠加透明 `<input type="range">`，仅显示白色圆点 thumb
  - `input` 事件：拖动期间 `clearTimeout` 暂停自动前进，实时预览目标位置的照片名/时间/进度宽度
  - `change` 事件：清除当前高亮、释放当前临时 marker、`player.idx` 跳到目标、调 `tickPlay()` 重新高亮并按当前速度/暂停状态调度
  - 自动播放推进时，`tickPlay` 同步刷新 `hudSeek.value`，手柄跟随
- 播放区间点位区分
  - 开始播放时构建 `player.listSet`（hash → true）
  - 缩略图模式：非本次播放的点位加 `pm-out` 类（橙色边框 + 不透明度 0.5），当前播放高亮即使被标记 out 也恢复不透明度 1
  - 圆点模式：非本次播放的圆点填充色由蓝 `#2b6cff` 改为橙 `#ff9500`
  - 停止播放时 `clearPlayStyles` 还原所有点位为默认蓝色
- 播放区间记忆
  - 开始播放时将起止时间写入 `localStorage` 键 `pw_playStart` / `pw_playEnd`
  - 打开播放设置弹窗时优先读取缓存值，无缓存才用全时间范围
  - 隐私模式 `localStorage` 抛错时静默忽略
- `.gitignore` 将 `photos.db` / `photos_*.db` 两条规则合并为通配 `*.db`

## Capabilities
### New Capabilities
- `photo-delete`: 单张照片删除能力的对外可观察行为，覆盖删除入口、确认弹窗、即时持久化、与播放状态联动
- `photo-playback`: 时间轴播放能力的对外可观察行为，覆盖播放启停、速度调整、进度条 seek、播放区间点位区分、播放区间记忆

### Modified Capabilities
<!-- 本次为项目新增的第 3、4 个 capability，与既有 overseas-basemap、photo-render-layering 互不依赖，无修改项 -->

## Impact
- **代码**：
  - `app.js`：新增 `viewerPhoto`/`player.listSet` 状态、`openDelModal`/`hideDelModal`/`deleteCurrentPhoto`/`applyPlayStyles`/`clearPlayStyles` 函数、HUD 速度与进度条事件绑定、`openPlayModal`/`startPlay`/`stopPlay`/`tickPlay` 调整
  - `index.html`：新增 `.pm-out` 样式、`.viewer-del` 样式与按钮、`#hudSeek` 透明 range、`#hudSpeed` 速度选择器、`#delModal` 删除确认弹窗
  - `.gitignore`：合并 `*.db` 通配规则
- **依赖**：无新增第三方库，复用既有 DOM/Leaflet/sql.js 能力
- **行为**：
  - 删除：单张照片可即时从数据库与地图移除并持久化，无需额外「保存数据」
  - 播放：速度可在 0.5×–8× 间实时切换；进度条可拖动跳转；播放期间非本次播放点位视觉降级（橙/淡）；播放区间在重复打开设置弹窗时自动带入
  - 视觉：非播放点位在播放期间由蓝色变为橙色（圆点）或加橙色边框并降低不透明度（缩略图）
- **风险**：
  - 删除即时持久化不可撤销，确认弹窗文案已明确警示，但用户误操作仍可能丢数据
  - `localStorage` 在 file:// 协议下部分浏览器禁用，区间记忆会静默失效（不影响其他功能）
  - 进度条拖动期间暂停自动前进，若用户拖动后未释放即关闭 HUD，`change` 不会触发，`player.idx` 仍为旧值——已由 `stopPlay` 重置状态兜底
