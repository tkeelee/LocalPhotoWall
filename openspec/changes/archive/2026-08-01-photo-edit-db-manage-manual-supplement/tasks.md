# Tasks — 照片编辑 / 数据库直接管理 / 手动补录 / 去重覆盖

## 1. 查看器内编辑
- [x] 1.1 `index.html` 新增 `.viewer-edit` 样式（铅笔图标按钮，位于删除按钮左侧）
- [x] 1.2 `index.html` 新增 `#viewerMeta .ve-form/.ve-row/.ve-actions` 表单样式
- [x] 1.3 `app.js` `buildViewer` 注入编辑按钮 SVG
- [x] 1.4 `app.js` 实现 `openViewerEditor`/`saveViewerEdit`/`renderViewerMeta`/`escapeAttr`
- [x] 1.5 `app.js` 绑定 `#viewerEditBtn` click（`stopPropagation` + 打开编辑表单）
- [x] 1.6 `app.js` 保存逻辑：`UPDATE photos SET name=?,path=?` + 内存同步 + `saveData()` + Toast

## 2. 查看器 hover 延迟关闭
- [x] 2.1 `index.html` `.frame` 与 `#viewerMeta` 增加 `pointer-events:auto`
- [x] 2.2 `app.js` 新增 `viewerCloseTimer`/`VIEWER_HOVER_DELAY=220`
- [x] 2.3 `app.js` 实现 `scheduleViewerClose`/`cancelViewerClose`
- [x] 2.4 `app.js` `buildViewer` 内 `bindHover` 绑定 frame 与 `#viewerMeta` 的 enter/leave
- [x] 2.5 `app.js` 缩略图 `mouseleave` 改调 `scheduleViewerClose`
- [x] 2.6 `app.js` `dismissHandler` 排除 `.frame,#viewerMeta` 与 `#viewerEditBtn`
- [x] 2.7 `app.js` `closeViewer` 调用 `cancelViewerClose`

## 3. 数据库直接管理弹窗
- [x] 3.1 `index.html` dock 栏新增 `#btnDbManage`（表格网格 SVG，title="数据库直接管理"）
- [x] 3.2 `index.html` 新增 `#dbManageModal` 弹窗（toolbar/filter-row/scroll/page-row/detail/result/modal-actions）
- [x] 3.3 `index.html` 新增 `#csvInput` 隐藏文件输入
- [x] 3.4 `index.html` 新增 `.db-scroll` 表格样式、`.db-detail` 详情样式、`.db-filter-row`/`.db-page-row`/`.db-result` 样式
- [x] 3.5 `app.js` 新增 `dbMgr` 状态对象与 `DB_COLUMNS` 列定义
- [x] 3.6 `app.js` 实现 `openDbManage`（默认内存模式，`pageSize` 响应式）
- [x] 3.7 `app.js` 实现 `queryDbRows`/`applyFilter`/`updateFilterInfo`/`fmtDate`/`pad2`
- [x] 3.8 `app.js` 实现 `renderDbTable`/`renderPageRow`/`startEditCell`/`renderDbDetail`
- [x] 3.9 `app.js` 实现 `csvEscape`/`exportDbCsv`（UTF-8 BOM + RFC 4180 + CRLF）
- [x] 3.10 `app.js` 实现 `parseCsv`/`importDbCsv`/`applyCsvOverwrite`/`showDbCsvResult`/`rebuildPhotosFromDb`
- [x] 3.11 `app.js` 实现 `saveDbEdits`（事务 + 内存同步 + `saveData()`/`persistFileDb()`）
- [x] 3.12 `app.js` 实现 `persistFileDb`（`createWritable` + `write(export())` + `close`）
- [x] 3.13 `app.js` 实现 `pickDbFileForManage`（`showOpenFilePicker` + 未保存 confirm）
- [x] 3.14 `app.js` 实现 `closeDbManage`（清理 fileDb 句柄 + 未保存 confirm）
- [x] 3.15 `app.js` `bindUI` 绑定 `#btnDbManage`/`#dbManageClose`/`#dbPickFile`/`#dbExportCsv`/`#dbImportCsv`/`#csvInput`/`#dbSaveEdit`/筛选/分页事件

## 4. 手动补录
- [x] 4.1 `index.html` dock 栏新增 `#btnManual`（瞄准镜 SVG，title="手动补录"）
- [x] 4.2 `index.html` 新增 `#manualModal` 弹窗（coord-row/field/file-pick/manual-hint）
- [x] 4.3 `index.html` 新增 `#manualPhotoInput` 隐藏文件输入
- [x] 4.4 `index.html` 新增 `body.manual-mode .leaflet-container{cursor:crosshair}` 与 `#btnManual.on` 样式
- [x] 4.5 `app.js` 新增 `manualMode`/`manualPending`/`manualLatLng` 状态
- [x] 4.6 `app.js` 实现 `gcj02ToWgs84`（迭代 5 次逼近）
- [x] 4.7 `app.js` 实现 `toggleManualMode`（数据库校验 + `contextmenu` 绑定/解绑）
- [x] 4.8 `app.js` 实现 `onMapLongPress`（播放中拦截 + 调 `openManualModal`）
- [x] 4.9 `app.js` 实现 `openManualModal`/`resetManualFile`
- [x] 4.10 `app.js` 实现 `onManualPhotoChange`（`processFile` + 哈希判重 + EXIF 时间锁定）
- [x] 4.11 `app.js` 实现 `saveManualPhoto`（经纬度/时间校验 + `ensureDb` + `insertPhoto` + 内存更新 + `scheduleRender` + `saveData()`）
- [x] 4.12 `app.js` `bindUI` 绑定 `#btnManual`/`#manualCancel`/`#manualSave`/`#manualFilePick`/`#manualPhotoInput`

## 5. 重复哈希策略变更
- [x] 5.1 `app.js` 导入逻辑：`hashSet` 命中时由 `continue` 改为 `UPDATE photos SET 全字段 WHERE hash=?`
- [x] 5.2 `app.js` 统计字段 `skipped` 改为 `updated`
- [x] 5.3 `app.js` Toast 文案改为「X 张哈希重复已覆盖（后载入为准）」「实际导入 X 张、覆盖 Y 张」

## 6. .gitignore
- [x] 6.1 `.gitignore` 新增 `*.csv` 规则

## 7. OpenSpec
- [x] 7.1 起草 `openspec/changes/2026-08-01-photo-edit-db-manage-manual-supplement/` 4 件套
- [x] 7.2 为 4 个新 capability 写 delta spec
- [x] 7.3 归档提案到 `openspec/changes/archive/`
- [x] 7.4 回写 `openspec/specs/<capability>/spec.md`
- [ ] 7.5 git 提交
