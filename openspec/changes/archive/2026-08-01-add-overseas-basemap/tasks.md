# 实现任务清单

> 说明：本次为对工作区已有增量改动的回溯性提案，实现已落于 `app.js` / `index.html` 未提交改动中，任务标记为已完成。验收时对照 `specs/overseas-basemap/spec.md` 的 Scenario 逐条确认。

## 1. 状态与配置
- [x] 1.1 新增状态变量 `overLayers`（海外底图 id → Layer）、`inChinaNow`（默认 true）、`offlineReady`（默认 false）
- [x] 1.2 定义 `OVER_CFG` 海外底图配置数组（std=OSM、sat=Esri World Imagery、label=Esri World Boundaries），含 id/url/sub/ext/attr

## 2. 海外底图层
- [x] 2.1 实现 `offlineTileLayer(cfg)`：重写 `createTile`，`offlineReady` 为真时先读本地 `tiles/<id>/<z>/<x>/<y>.<ext>`，失败回源；为假时直接回源
- [x] 2.2 在 `initMap` 中遍历 `OVER_CFG` 创建海外图层实例存入 `overLayers`
- [x] 2.3 配置 `minZoom:3 / maxZoom:19 / maxNativeZoom:18` 与 attribution

## 3. 区域判定与切换
- [x] 3.1 实现 `inChina(lat, lng)`：边界 `lng>73.66 && lng<135.05 && lat>3.86 && lat<53.55`，与 exif.js `outOfChina` 一致
- [x] 3.2 实现 `applyBasemap()`：先移除所有现存底图层，再按 `inChinaNow × isSatellite` 四象限加载对应图层（国内高德 / 海外全球瓦片）
- [x] 3.3 实现 `detectRegion()`：`moveend` 时取中心点判定区域，变化则更新 `inChinaNow`、调用 `applyBasemap()`、Toast 提示
- [x] 3.4 `initMap` 中绑定 `map.on('moveend', detectRegion)`
- [x] 3.5 `initMap` 中以 `applyBasemap()` 取代直接 `stdLayer.addTo(map)`

## 4. 图层切换重构
- [x] 4.1 重构 `toggleLayer()`：仅翻转 `isSatellite`、调用 `applyBasemap()`、切换按钮 `.on` 类、Toast 提示
- [x] 4.2 移除原 `toggleLayer` 中分散的 `addLayer/removeLayer` 与分支

## 5. 离线下载（保留禁用）
- [x] 5.1 `initMap` 中 `offlineReady = localStorage...` 一行保持注释，恒为 false
- [x] 5.2 以注释保留离线下载工具函数（`lon2tileX`/`lat2tileY`/`tileRemoteUrl`/`computeOverseasTiles`/`downloadOfflineTiles` 等）
- [x] 5.3 以注释保留 `openOfflineModal`/`updateOfflineEstimate`/`startOfflineDownload` 流程
- [x] 5.4 `bindUI` 中离线下载相关事件绑定全部注释保留
- [x] 5.5 注释中写明重新启用步骤（换 CORS 源、取消注释、恢复 localStorage 读取）

## 6. UI 适配
- [x] 6.1 `index.html` 新增 `.prog-cancel` 样式（含 hover）
- [x] 6.2 注释保留 `btnOffline` 按钮（dock 区）
- [x] 6.3 注释保留 `progCancel` 按钮（进度条区）
- [x] 6.4 注释保留 `offlineModal` 弹窗（含层级/边距/图层选择/估算提示）

## 7. 验收
- [ ] 7.1 国内中心点：标准模式显示高德路网，卫星模式显示高德卫星+路网
- [ ] 7.2 海外中心点：标准模式显示 OSM，卫星模式显示 Esri 影像+地名标注
- [ ] 7.3 平移跨越国境时自动切换并 Toast 提示
- [ ] 7.4 海外照片缩略图与海外底图地理位置一致，无偏移
- [ ] 7.5 默认无离线下载入口，海外瓦片直接走远端
