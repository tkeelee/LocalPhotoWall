# 实现任务清单

> 说明：本次为对工作区已有增量改动的回溯性提案，实现已落于 `app.js` / `index.html` / `.gitignore` 未提交改动中，任务标记为已完成。验收时对照 `specs/photo-delete/spec.md` 与 `specs/photo-playback/spec.md` 的 Scenario 逐条确认。

## 1. 照片删除
- [x] 1.1 `index.html` 新增 `.viewer-del` 样式（绝对定位右上、圆形、hover 变红）与 `.frame` 内删除按钮 SVG
- [x] 1.2 `index.html` 新增 `#delModal` 确认弹窗（标题/描述/否/是）
- [x] 1.3 `app.js` 新增 `viewerPhoto` 状态，`openViewer` 中保存当前照片引用并绑定删除按钮 click（`stopPropagation`）
- [x] 1.4 `app.js` `dismissHandler` 增加删除按钮与照片标记本身的排除判断
- [x] 1.5 `app.js` 实现 `openDelModal`/`hideDelModal`/`deleteCurrentPhoto`
- [x] 1.6 `deleteCurrentPhoto`：数据库 `DELETE`、移除 marker（thumbLayer/dotLayer/独立 marker）、清理 `photos`/`hashSet`、播放状态联动、`closeViewer`、`updateStat`、`scheduleRender`、`saveData`
- [x] 1.7 `app.js` `closeViewer` 中清空 `viewerPhoto`、`hideDelModal` 兜底
- [x] 1.8 绑定 `#delCancel`/`#delConfirm`/`#delModal` 蒙层点击关闭

## 2. 播放速度实时调整
- [x] 2.1 `index.html` 新增 `#playHud .hud-speed select` 与 5 档 option
- [x] 2.2 `app.js` `startPlay` 中初始化 `$('hudSpeed').value = String(speed)`
- [x] 2.3 `app.js` 绑定 `hudSpeed` `change`：更新 `player.speed`，运行中且未暂停时 `clearTimeout` + 按新 `interval()` 重排

## 3. 进度条拖动 seek
- [x] 3.1 `index.html` `.pbar` 改 `position:relative`，新增透明 `#hudSeek` range + webkit/moz thumb 样式
- [x] 3.2 `app.js` `startPlay` 中初始化 `$('hudSeek').value = 0`
- [x] 3.3 `app.js` `tickPlay` 中同步 `$('hudSeek').value = Math.round(player.idx / (list.length - 1) * 100)`
- [x] 3.4 `app.js` 绑定 `hudSeek` `input`：`clearTimeout` 暂停自动前进，预览目标位置 name/time/bar
- [x] 3.5 `app.js` 绑定 `hudSeek` `change`：清除当前高亮、释放当前 marker、跳转 `player.idx`、调 `tickPlay` 重新调度

## 4. 播放区间点位区分
- [x] 4.1 `app.js` `player` 状态新增 `listSet`
- [x] 4.2 `index.html` 新增 `.pm.pm-out .pm-box`（橙边框 + opacity .5）与 `.pm.pm-out.active .pm-box`（opacity 1）样式
- [x] 4.3 `app.js` `createThumbMarker` 中按 `player.listSet` 判定加 `pm-out` 类
- [x] 4.4 `app.js` `createDotMarker` 中按 `player.listSet` 判定 fillColor 蓝/橙
- [x] 4.5 `app.js` `startPlay` 构建 `player.listSet` 并调 `applyPlayStyles`
- [x] 4.6 `app.js` `stopPlay` 清空 `player.listSet` 并调 `clearPlayStyles`
- [x] 4.7 `app.js` 实现 `applyPlayStyles`/`clearPlayStyles` 批量更新 dot 与 el

## 5. 播放区间记忆
- [x] 5.1 `app.js` `openPlayModal` 优先读 `localStorage.pw_playStart`/`pw_playEnd`，无则用全范围
- [x] 5.2 `app.js` `startPlay` 中 `try/catch` 写 `localStorage` 两个键
- [x] 5.3 `stopPlay` 中先记录 `total = player.list.length` 再清空，用于结束 toast

## 6. .gitignore
- [x] 6.1 合并 `photos.db` / `photos_*.db` 为 `*.db` 通配规则

## 7. 验收
- [ ] 7.1 大图查看器右上角显示删除按钮，hover 变红
- [ ] 7.2 点击删除按钮弹确认框，文案为「将立即从照片墙数据库文件内删除，切不可恢复，是否继续？」
- [ ] 7.3 点「否」返回查看器，点「是」照片从地图与数据库消失并已写盘（重启加载确认）
- [ ] 7.4 播放中删除当前照片自动停止播放；删除列表中其他照片播放继续且不错位
- [ ] 7.5 HUD 速度选择器 5 档，切换后立即按新速度推进（不等当前 tick 到期）
- [ ] 7.6 拖动进度条期间自动前进暂停，HUD 文本/进度宽度实时预览目标位置
- [ ] 7.7 释放进度条后跳转到目标照片，高亮与地图平移正确
- [ ] 7.8 自动播放推进时进度条手柄同步跟随
- [ ] 7.9 播放期间非本次播放的缩略图橙边框 + 半透明，圆点橙色；当前播放高亮即使 out 也恢复不透明度 1
- [ ] 7.10 停止播放后所有点位恢复默认蓝色
- [ ] 7.11 重复打开播放设置弹窗时，起止时间自动带入上次值
- [ ] 7.12 file:// 协议下 localStorage 禁用时，播放功能正常（区间记忆静默失效）
