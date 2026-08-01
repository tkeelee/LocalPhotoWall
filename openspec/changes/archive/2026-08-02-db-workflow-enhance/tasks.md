# 实现任务清单

> 说明：本次为数据库持久化工作流增强，涉及导入前置校验、未初始化引导流程、增量加载双选项菜单与自动建库、写操作即时持久化、保存改备份、目录记忆、管理独立化 7 项变更。实现前需对照 `specs/db-persistence/spec.md`、`specs/photo-import-dedup/spec.md`、`specs/photo-db-manage/spec.md`、`specs/photo-manual-supplement/spec.md` 的 Scenario 逐条确认。

## 1. 导入前置数据库校验
- [x] 1.1 `app.js` 新增 `hasPersistenceTarget()` 工具函数：返回 `!!(saveDirHandle || dbHandle)`
- [x] 1.2 `app.js` `btnImport` 点击事件前置校验：`!db || !hasPersistenceTarget()` 时进入未初始化引导流程（见第 2 节），不展开菜单
- [x] 1.3 `app.js` `dirInput`/`fileInput` change 事件前置校验：无持久化目标时清空 value 并 return，不调用 `handleFiles`
- [x] 1.4 `app.js` `toggleManualMode` 校验条件从 `!db` 改为 `!db || !hasPersistenceTarget()`，toast 文案保持「请先加载数据库文件再补录（补录需写入数据库并按哈希判重）」

## 2. 未初始化引导流程
- [x] 2.1 `app.js` 新增模块级 `initGuard` 防重入锁变量
- [x] 2.2 `app.js` `btnImport` 点击时若未初始化：置 `initGuard=true`，输出提示 A「请先加载数据库文件再导入（导入需写入数据库并按哈希判重）」，延时 2.5s 后输出提示 B「检测到未初始化，正在引导您选择初始空间...」，再延时 1.5s 后调 `loadDbFromDir(true)`，完成后释放锁
- [x] 2.3 `app.js` `btnManual` 点击时若未初始化：同上流程，提示 A 文案为补录版
- [x] 2.4 `app.js` `loadDbFromDir(skipHint)` 支持 `skipHint=true` 跳过内部「请选择要加载数据库的目录」提示，避免覆盖提示 B
- [x] 2.5 `app.js` 引导流程返回 `Promise<boolean>`，成功/取消/失败均释放 `initGuard`

## 3. 增量加载双选项菜单与自动建库
- [x] 3.1 `index.html` 新增 `#loadMenu` 菜单，含两个 `.menu-item`：「增量加载」（`data-act="file"`）与「初始空间」（`data-act="dir"`），样式复用 `#importMenu`
- [x] 3.2 `app.js` `btnLoad` 点击事件改为切换 `#loadMenu` 显隐；点外部关闭菜单；菜单项点击按 `data-act` 分发
- [x] 3.3 `app.js` `data-act="file"` 走原 `pickDbFile()`（选已有 `.db` 文件追加合并）
- [x] 3.4 `app.js` `data-act="dir"` 走新 `loadDbFromDir()`：`showDirectoryPicker({ id: 'pw_load_source', mode: 'readwrite' })` 选目录
- [x] 3.5 `app.js` `loadDbFromDir` 目录存在 `photos.db`：读取 arrayBuffer → `loadDbBytes()` → `reportLoad()`
- [x] 3.6 `app.js` `loadDbFromDir` 目录不存在 `photos.db`：独立空库实例 → `run(SCHEMA)` → 导出 bytes → 写入目录 `photos.db` → `loadDbBytes()` 空数据 → 手动收尾 + toast「目录下不存在初始库文件，已自动创建」（跳过 reportLoad 的「共加载 0 张」）
- [x] 3.7 `app.js` `loadDbFromDir` 首次使用（`!saveDirHandle`）时将源目录同时设为工作目录，并写 localStorage 记忆
- [x] 3.8 `app.js` 浏览器不支持 `showDirectoryPicker` 时 `loadDbFromDir` 降级为 `$('dbInput').click()`

## 4. 写操作即时持久化
- [x] 4.1 `app.js` `finishImport` 末尾 `if (saveDirHandle && dbDirty) saveData()` 改为 `saveData(true)`（静默无条件）
- [x] 4.2 `app.js` `finishImport` 静默写入完成后输出合并提示（含「已保存到 xxx/photos.db」），避免连续 toast 覆盖
- [x] 4.3 `app.js` `reportLoad` 末尾以 `hasChange = r.added || r.updated` 判断：有变更调 `saveData(true)` 并追加「已保存到」；无变更仅输出统计不落盘
- [x] 4.4 验证补录 `saveManualPhoto`（已有 `saveData`）、删除 `deleteCurrentPhoto`（已有 `saveData`）、编辑保存（已有 `saveData`）行为不变
- [x] 4.5 `app.js` `saveData(silent)` / `writeToDir(bytes, silent)` 支持 `silent=true` 时不显示「已保存到」、不触发下载提示

## 5. 保存按钮改为备份功能
- [x] 5.1 `index.html` `btnSave` title/aria-label 从「保存数据」改为「备份数据库」
- [x] 5.2 `app.js` 新增 `backupTsName()`：生成 YYMMDDHHMMSS 时间戳（两位年 + 月日时分秒）
- [x] 5.3 `app.js` 新增 `backupDb()`：`ensureProjectDir()` → `db.export()` → 以 `photos_YYMMDDHHMMSS_bak.db` 写入目录 → toast「已备份为 ...」；无目录时降级下载
- [x] 5.4 `app.js` `btnSave` 事件绑定从 `saveData` 改为 `backupDb`
- [x] 5.5 `app.js` `ensureDb` 中 `show($('btnSave'))`：数据库就绪后始终显示备份按钮（不再依赖 `dbDirty`）
- [x] 5.6 `app.js` `writeToDir` 去掉覆盖前自动备份逻辑，直接覆盖 `photos.db`（备份仅由 `backupDb` 触发）
- [x] 5.7 `app.js` `markDirty` 保留（橙色脏点仍作为弱提示），但 `btnSave` 不再依赖它控制显隐

## 6. 工作目录记忆
- [x] 6.1 `app.js` `ensureProjectDir` 调 `showDirectoryPicker` 时加 `{ id: 'pw_project_dir', mode: 'readwrite' }` 参数
- [x] 6.2 `app.js` `ensureProjectDir` 选目录成功后 `try/catch` 写 `localStorage`：`pw_last_dir_name`=目录名、`pw_last_dir_time`=时间戳
- [x] 6.3 `app.js` `ensureProjectDir` 首次选目录前 `try/catch` 读 `pw_last_dir_name`，有值则 toast「建议选择上次的目录「xxx」（若仍可用）」，无值则 toast 通用引导
- [x] 6.4 `app.js` `ensureProjectDir` 不支持 `showDirectoryPicker` 时跳过记忆逻辑（降级路径不变）

## 7. 数据库管理独立化
- [x] 7.1 `app.js` `openDbManage` 内存模式增加只读标记：`dbMgr.readonly = true`
- [x] 7.2 `index.html` `dbManageDesc` 描述更新：补充「内存模式仅只读预览，如需编辑请选择其他 db 文件」
- [x] 7.3 `app.js` 新增 `updateDbManageWriteButtons()`：只读模式禁用「保存修改」「导入 CSV 覆盖」按钮（disabled + 灰显 + not-allowed 光标）
- [x] 7.4 `app.js` 新增 `isCurrentLoadedDb(handle)`：目录模式比 `handle.name === 'photos.db'` + `saveDirHandle.resolve` 同目录；文件模式比 `handle.name === dbHandle.name` + `getFile` 比对 size/lastModified
- [x] 7.5 `app.js` `pickDbFileForManage` 选中文件后调 `isCurrentLoadedDb`：是当前加载文件则 `readonly=true` 以只读模式加载，标识「只读预览，当前正在加载的数据库」；否则 `readonly=false` 可编辑
- [x] 7.6 `app.js` 双击编辑单元格事件加 `if (dbMgr.readonly) return` 防御
- [x] 7.7 `app.js` `saveDbEdits`/`importDbCsv` 增加 readonly 防御校验
- [x] 7.8 `app.js` `closeDbManage` 重置 `dbMgr.readonly = true`

## 8. 验收
- [x] 8.1 未加载数据库时点击「导入照片」依次输出两条提示后自动弹目录选择器引导初始空间，不展开菜单
- [x] 8.2 数据库已加载但未选工作目录时点击「导入照片」同样触发引导流程（持久化目标缺失）
- [x] 8.3 补录按钮未初始化时触发与导入一致的引导流程（提示 A 文案为补录版）
- [x] 8.4 双击/事件冒泡不会触发重复引导（`initGuard` 防重入）
- [x] 8.5 点击「增量加载数据」弹出双选项菜单：「增量加载」与「初始空间」
- [x] 8.6 「增量加载」选已有 `.db` 文件正常追加合并并即时落盘
- [x] 8.7 「初始空间」选目录，目录有 `photos.db` 时正常增量合并并即时落盘
- [x] 8.8 「初始空间」选目录，目录无 `photos.db` 时自动创建空库、加载、提示「目录下不存在初始库文件，已自动创建」
- [x] 8.9 导入照片完成后数据自动写入数据库文件（无需手动点保存），提示合并为单条
- [x] 8.10 增量加载有实际新增/覆盖时自动写入；全量重复时不写入、不提示已保存
- [x] 8.11 「保存数据」按钮显示为「备份数据库」，点击后生成 `photos_YYMMDDHHMMSS_bak.db`，主库不受影响
- [x] 8.12 备份按钮在数据库存在时始终可点击（不依赖脏标记）
- [x] 8.13 常规写操作（导入/加载/补录/删除/编辑）直接覆盖主库，不自动生成备份
- [x] 8.14 首次选目录后再次选目录，提示「建议选择上次的目录「xxx」」，浏览器优先定位该目录
- [x] 8.15 打开数据库管理弹窗，内存模式下「保存修改」「导入 CSV 覆盖」按钮禁用、双击单元格不进入编辑
- [x] 8.16 管理弹窗选择当前正在加载的 db 文件时以只读模式加载，标识「只读预览，当前正在加载的数据库」，写操作禁用
- [x] 8.17 管理弹窗选择其他独立 db 文件后写操作按钮启用，可编辑保存写回原文件
