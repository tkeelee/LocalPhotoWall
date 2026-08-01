## Why
照片墙此前的数据维护能力存在四处空白：(1) 单张照片的文件名/路径在导入后无法修正，命名错误或路径迁移只能重建数据库；(2) 数据库内容对用户不可见，无法在不重新导入的情况下批量检视与编辑，也无 CSV 等可移植格式进出；(3) 无 GPS 的照片（如扫描老照片、剥离 EXIF 的截图）在导入时被直接丢弃，无法事后补坐标；(4) 多次加载数据库遇到重复哈希时直接跳过，后载入的更正数据无法生效，与"后载入为准"的工程约束不一致。此外大图查看器在鼠标滑出缩略图时立即关闭，导致用户难以移动指针到查看器内的按钮或选中元信息文字。本次改动补齐这五项能力，使照片墙在长期使用与数据治理场景下更可靠。

## What Changes
- 查看器内编辑文件名/路径
  - 大图查看器删除按钮左侧新增铅笔图标编辑按钮（无文字）
  - 点击编辑按钮把 `#viewerMeta` 替换为内联表单：文件名、照片路径可编辑；经纬度、拍摄时间、尺寸为只读展示
  - 「保存」：校验文件名非空，`UPDATE photos SET name=?,path=? WHERE hash=?`，更新内存 `photos` 项，立即 `saveData()` 持久化，刷新查看器元信息
  - 「取消」：放弃修改，重新渲染只读元信息
  - 编辑/删除按钮点击 `stopPropagation`，不触发查看器 dismiss
- 查看器 hover 延迟关闭
  - 鼠标离开缩略图、frame、`#viewerMeta` 时不立即关闭，启动 220ms 延迟
  - 鼠标进入 frame 或 `#viewerMeta` 取消延迟，允许操作按钮与选中文字
  - dismiss 处理新增 `.frame,#viewerMeta` 排除项，点击查看器内部不关闭
  - `closeViewer` 调用 `cancelViewerClose` 清理计时器
- 数据库直接管理弹窗
  - dock 栏新增「数据库直接管理」按钮，图标为表格网格 SVG，与「加载数据库」（圆柱图标）视觉区分
  - 弹窗数据来源默认为当前内存数据库；可点击「选择 db 文件」切换为外部 `.db` 文件预览/编辑（用 `showOpenFilePicker` 取句柄，编辑后写回原文件）
  - 表格分页展示：PC 10 条/页、手机 5 条/页；列含缩略图、哈希、文件名、路径、拍摄时间、纬度、经度、海拔、宽、高、大小、缩略图尺寸、导入时间
  - 双击文件名/路径单元格进入行内编辑，回车或失焦提交，Esc 取消；标记 `dirty`
  - 「保存修改」按行批量 `UPDATE`，事务包裹；内存模式同步回 `photos` 数组并 `saveData()`，文件模式 `persistFileDb()` 写回原句柄
  - 按拍摄时间区间筛选（起止 date input，含两端），「全部」按钮重置；筛选后页码归零
  - 「导出 CSV」：UTF-8 BOM + RFC 4180 转义 + CRLF，文件名 `photos_<ts>.csv` 或外部文件名前缀
  - 「导入 CSV 覆盖」：解析后按哈希做全量增/改/删（事务），结果区显示新增/更新/删除计数；内存模式触发 `rebuildPhotosFromDb()` 重建地图标记并 `saveData()`
  - 有未保存编辑时切换文件或关闭弹窗 SHALL 弹 `confirm` 警告
- 手动补录点位
  - dock 栏新增「手动补录」按钮（瞄准镜 SVG）；点击切换补录模式，激活时按钮高亮、地图光标变十字
  - 进入补录模式前 SHALL 校验数据库已加载，未加载给出提示且不进入
  - 长按地图（`contextmenu` 事件）选点：播放中需先暂停，否则提示；将点击位置 GCJ02→WGS84 逆转换后填入弹窗
  - 弹窗字段：纬度、经度（WGS84）、拍摄时间（datetime-local）、点位照片（file input）
  - 选择照片后调用既有 `processFile` 解析：若哈希已存在于 `hashSet`，禁止补录并提示；若有 EXIF 时间，时间字段锁定显示照片时间；否则由用户手动填写（标记 `approxTime`）
  - 「保存」：校验经纬度范围与时间非空，`ensureDb` 后 `insertPhoto` + 加入 `photos`/`hashSet` + `preparePhoto` + `scheduleRender` + `saveData()` 立即持久化
  - 退出补录模式 `map.off('contextmenu')`、关闭弹窗、移除十字光标
- 重复哈希策略变更
  - 导入/加载时遇到 `hashSet` 中已存在的哈希，由"跳过"改为"覆盖"：`UPDATE` 全字段为后载入值，统计字段由 `skipped` 改为 `updated`
  - Toast 文案：`X 张哈希重复已覆盖（后载入为准）`、`实际导入 X 张、覆盖 Y 张`
  - memory 中"加载多个数据库遇到重复哈希时后载入数据优先"的硬约束由此正式化为 spec
- `.gitignore` 新增 `*.csv` 规则（导出的 CSV 不入库）

## Capabilities
### New Capabilities
- `photo-edit`: 大图查看器内编辑单张照片文件名与照片路径，保存后即时持久化
- `photo-db-manage`: 数据库直接管理，覆盖外部/内存数据库切换、分页浏览、行内编辑、CSV 导入导出、按时间区间筛选
- `photo-manual-supplement`: 为无 GPS 照片手动补录坐标，长按地图选点 + 照片解析 + 哈希判重 + 即时持久化
- `photo-import-dedup`: 照片导入/加载的去重策略，由"跳过重复哈希"改为"后载入覆盖"

### Modified Capabilities
<!-- 本次为项目新增的第 5–8 个 capability，与既有 overseas-basemap / photo-render-layering / photo-delete / photo-playback 互不依赖 -->

## Impact
- **代码**：
  - `app.js`：
    - 新增 `viewerCloseTimer`/`scheduleViewerClose`/`cancelViewerClose`/`openViewerEditor`/`saveViewerEdit`/`renderViewerMeta`/`escapeAttr`
    - 新增 `dbMgr` 状态机与 `openDbManage`/`queryDbRows`/`applyFilter`/`renderDbTable`/`renderPageRow`/`startEditCell`/`renderDbDetail`/`exportDbCsv`/`parseCsv`/`importDbCsv`/`applyCsvOverwrite`/`showDbCsvResult`/`rebuildPhotosFromDb`/`saveDbEdits`/`persistFileDb`/`pickDbFileForManage`/`closeDbManage`/`fmtDate`/`pad2`/`csvEscape`
    - 新增 `manualMode`/`manualPending`/`manualLatLng` 状态与 `gcj02ToWgs84`/`toggleManualMode`/`onMapLongPress`/`openManualModal`/`resetManualFile`/`onManualPhotoChange`/`saveManualPhoto`
    - 修改导入去重逻辑：`skipped` → `updated`，`INSERT` 失败时改为 `UPDATE`
    - `bindUI` 新增两组按钮与 CSV/手动补录事件绑定
  - `index.html`：
    - 新增 `.viewer-edit` 样式与按钮、`#viewerMeta .ve-form/.ve-row/.ve-actions` 表单样式
    - `.frame` 与 `#viewerMeta` 增加 `pointer-events:auto`
    - 新增 `#dbManageModal` 弹窗（toolbar/filter-row/scroll/page-row/detail/result）、`#manualModal` 弹窗（coord-row/file-pick/hint）
    - dock 栏新增 `#btnDbManage`（表格网格 SVG）与 `#btnManual`（瞄准镜 SVG）按钮
    - 新增 `#csvInput` 与 `#manualPhotoInput` 隐藏文件输入
  - `.gitignore`：新增 `*.csv`
- **依赖**：无新增第三方库；`showOpenFilePicker`/`createWritable` 依赖 Chromium 内核浏览器，不兼容时降级提示
- **行为**：
  - 查看器：鼠标移出后 220ms 延迟关闭，给用户移动指针到查看器内的时间；查看器内可编辑文件名/路径并即时持久化
  - 数据库管理：弹窗内可分页浏览/筛选/行内编辑/CSV 进出，外部 `.db` 文件可读写；CSV 覆盖按哈希全量增改删
  - 手动补录：长按地图为无 GPS 照片补坐标，EXIF 时间优先，哈希重复禁止保存
  - 去重：重复哈希不再跳过，后载入覆盖前值
- **风险**：
  - CSV 全量覆盖不可撤销，已加 `confirm` 二次确认；事务失败 `ROLLBACK` 兜底
  - `showOpenFilePicker` 仅 Chromium 支持，Safari/Firefox 下外部文件模式不可用（已提示，内存模式仍可用）
  - 手动补录经纬度为用户填写的 WGS84，与底图 GCJ02 之间已做逆转换，但仍可能因用户填错导致点位偏移
  - 重复哈希覆盖会丢失旧值（含 thumb/EXIF），与既有"哈希去重"直觉相反，Toast 文案已显式说明
  - 查看器延迟关闭 220ms 期间用户可能误以为已离开，但任何新交互都会取消计时器
