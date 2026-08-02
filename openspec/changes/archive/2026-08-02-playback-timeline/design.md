# 设计文档：播放时间刻度线

## 1. 目标与边界

**目标**：为播放态增加可视化时间尺度，让用户在不拖动进度条的情况下感知当前播放时间在整个区间内的位置，并支持按时间段跳转。

**边界**：
- 仅在 `player.running === true` 时显示
- 仅展示**本次播放列表**的时间跨度，不展示全库时间
- 不影响点位渲染、播放速度、暂停等其他播放能力

## 2. DOM 结构

在 `#playHud` 后新增同级容器：

```html
<div id="hudTimeline" class="hidden">
  <div class="ht-labels" id="htLabels"></div>
  <div class="ht-ticks" id="htTicks"></div>
  <div class="ht-playhead" id="htPlayhead"></div>
  <!-- 拖动跳转覆盖层 -->
  <div class="ht-hit" id="htHit"></div>
</div>
```

## 3. 样式要点

```
#hudTimeline:
  position:absolute; z-index:590;        /* #playHud=620, #panelLeft/#ctrlRight=600 */
  /* left/right/bottom 由 positionTimelineAboveHud() 动态设置：
     - bottom = viewportH - playHud.top + 6（位于播放条上方 6px 间隙）
     - left/right 按 #panelLeft/.dock 与 #ctrlRight/.ctrl-group 实际占位 + 12px sideGap 缩进 */
  padding:0 14px;
  height:34px; pointer-events:auto;       /* 允许拖动跳转 */
  background:var(--hud-bg);               /* 跟随标准浅玻璃 / 卫星深玻璃翻转 */
#htLabels: absolute; top:4px; height:14px; pointer-events:none;
#htTicks:  absolute; top:18px; height:14px; pointer-events:none;
#htPlayhead: absolute; top:0; bottom:0; width:2px; background:var(--brand);
#htHit: absolute; inset:0; cursor:pointer;
```

- **背景跟随主题**：`#hudTimeline` 用 `var(--hud-bg)`，标准底图浅玻璃、卫星底图深玻璃，避免与卫星影像混淆
- **铺满横向 + 图标避让**：`positionTimelineAboveHud()` 测量 `#panelLeft/.dock` 与 `#ctrlRight/.ctrl-group` 实际占位，左右缩进到 dock 之外；z-index 590 低于 docks 600，dock 玻璃背景自然覆盖其下方的刻度
- **明/暗底图可读**：刻度线与标签用 `var(--ink)` + 与玻璃背板同色的 `text-shadow`（`0 0 3px var(--hud-bg), 0 0 1px var(--hud-bg)`），无论明暗底图都能与文字互补

刻度等级：
- **年刻度**：高度 12px，`opacity:1`，含年份文字（如 `2024`）
- **月刻度**：高度 6px，`opacity:.78`，无文字

## 4. 刻度生成算法

输入：`startTs = list[0].takenTs`，`endTs = list[list.length-1].takenTs`

```text
if endTs == startTs or list.length <= 1:
    返回 false（调用方隐藏时间刻度线）

spanDays = (endTs - startTs) / 86_400_000
showMonthLabels = (spanDays <= 180)

# 始终同时绘制年刻度与月刻度（按用户要求「增加月刻度」）
# 月刻度：从 startTs 所在月 1 日逐月推进到 endTs 所在月，落在 [startTs, endTs] 内的每月 1 日
# 年刻度：月刻度中月份 === 0 的子集
```

实现要点：
- 月边界：从 `new Date(y0, m0, 1)` 起逐月 `setMonth(+1)` 推进到 `new Date(y1, m1+1, 1)`（不包含），仅收集落在 `[startTs, endTs]` 内的
- 年边界：月边界中 `getMonth() === 0` 的子集
- **两端强制年份**：除年边界外，额外在最左（`x=0`）标起始年 `y0`、最右（`x=100`）标结束年 `y1`，即使起点不在 1 月也能在边缘看到年份（用 `labeledYears` 去重避免与年边界重复）
- 刻度位置 = `(ts - startTs) / (endTs - startTs) * 100%`，限制在 `[0, 100]`
- 短区间（`spanDays <= 180`）额外在月刻度位置加 "X月" 文字标签

## 5. 同步与跳转

**当前位置游标**（playhead）位置 = `player.idx / max(1, list.length-1) * 100%`（与 `#hudBar` 一致，保证与进度条互相同步）。

**同步点**：
1. `tickPlay` 中更新 `#hudBar` 后调用 `updateTimelinePlayhead(idx)`，并同步 `#hudSeek.value`
2. `#hudSeek` 的 `input` 事件 → 调用 `updateTimelinePlayhead(idx)`
3. `#hudSeek` 的 `change` 事件 → 调用 `updateTimelinePlayhead(idx)`

**刻度线 → 进度跳转**（`#htHit` 监听 pointerdown / pointermove）：
- 计算 `targetIdx = round(clickX / width * (list.length - 1))`
- 复用 `#hudSeek.change` 跳转逻辑：清理当前高亮 → `player.idx = idx` → `tickPlay()`
- 拖动期间（pointermove）实时更新 `player.idx` 并暂停自动前进，逻辑与 `#hudSeek.input` 等价

## 6. 边缘场景

| 场景 | 处理 |
| ---- | ---- |
| `list.length <= 1` | `renderTimeline()` 返回 false，隐藏时间刻度线 |
| `endTs == startTs`（所有照片同一秒） | `renderTimeline()` 返回 false，隐藏时间刻度线 |
| 跨度 < 1 个月（不同时间） | 月刻度数量少，仍绘制落在区间内的月刻度 + 两端强制年份标签 |
| 跨度 1~6 个月 | 显示年/月刻度 + 月份文字标签（"X月"） |
| 跨度 6 个月~5 年 | 显示年/月刻度，年份带标签，月份无标签 |
| 跨度 ≥ 5 年 | 仍同时显示年/月刻度（年带标签、月无标签），两端强制年份保证可读 |
| 缩放/旋转设备 | `positionTimelineAboveHud()` 在 `startPlay` 与 `resize` 时重新定位 + 重新计算左右缩进 |

## 7. 不影响既有行为

- 不修改播放速度档位、播放区间记忆
- 不修改 `#playHud` 现有元素（仅在其后追加 `#hudTimeline`）
- 不修改播放结束 / 停止播放时的清理逻辑（仅追加 `hide(hudTimeline)`，并在 `clearPlayStyles` 中复位圆点半径 + 移除 `pm-out` / `pm-played` class）
- 点位样式变更仅限播放态：新增三态颜色与 `pm-played` class，停止播放后全部复位；非播放态点位视觉不变

## 8. 播放缩略图 / 区间外点位开关

播放设置弹窗新增两个复选框，状态在 `startPlay` 一次性读取并固定到本次播放实例（`player.showThumb` / `player.showOutRange`），播放中切换不影响本次播放。

| 开关 | 默认 | 关闭时 | 开启时 |
| ---- | ---- | ---- | ---- |
| 缩略图 `#playThumb` | 开 | 强制走 dot 模式，不创建任何缩略图 marker；当前活跃 dot 放大 + 亮橙 `#ff6b35` radius 8 | 走原有缩略图渲染（高缩放 thumbLayer / 低缩放为当前照片叠加临时缩略图） |
| 区间外点位 `#playOutRange` | 关 | 区间外点位从地图隐藏（不加入图层，已加入的移除），`applyPlayStyles` 跳过其样式计算 | 区间外点位以橙色降级显示（圆点橙 `#ff9500` / 缩略图橙框半透明），与既有行为一致 |

`renderVisible()` 关键分支：
- `showThumb=false` → 无视缩放级别，强制 dot 模式；`stopPlay` 后 `renderVisible()` 按缩放级别恢复
- `showOutRange=false` → 收集新增 / 移除视口外时跳过区间外点位

## 9. 播放区间点位视觉区分（四态）

原行为仅区分「区间内蓝 / 区间外橙」二态；本次升级为按「是否在播放列表内 × 是否已播过 × 是否为当前活跃」区分的四态：

| 状态 | 圆点模式（`showThumb=false` 或低缩放） | 缩略图模式（`showThumb=true` 且高缩放） |
| ---- | ---- | ---- |
| 区间外（仅 `showOutRange=true` 可见） | 橙 `#ff9500` radius 4 | `pm-out` class：橙框 + 半透明 |
| 区间内未播 | 蓝 `#2b6cff` radius 4 | 默认视觉 |
| 区间内已播 | 绿 `#34c759` radius 4 | `pm-played` class：降不透明度 |
| 当前活跃 | 亮橙 `#ff6b35` radius 8 | 放大 2 倍 + 抖动高亮，`marker.setZIndexOffset(2000)` |

**已播集合维护策略**（`player.playedHashes`）：
- **顺序前进**（`player.idx === player.lastIdx + 1`）：仅把上一张标记为已播并即时染色（O(1) 增量更新）
- **跳转前进 / 回退**（进度条拖动 / 时间刻度拖动）：按当前 `idx` 重建 `playedHashes`，调用 `applyPlayStyles()` 全量重染所有点位（保证跳到中间位置时，新位置之前的点位标记为已播、之后的标记为未播）

**停止播放**：`clearPlayStyles()` 复位圆点半径与颜色、移除 `pm-out` / `pm-played` class；`renderVisible()` 恢复所有点位可见性。