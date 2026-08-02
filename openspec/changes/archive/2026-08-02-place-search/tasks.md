# 实现任务清单

> 说明：本次为新增「地点搜索框」能力（capability: `place-search`）。实现前需对照 `specs/place-search/spec.md` 的 Scenario 逐条确认。所有任务均已在提交前完成（代码已落地，待归档验收）。

## 1. 搜索框入口与输入规则
- [x] 1.1 `index.html` 新增 `#searchBox` 结构：玻璃风输入包裹层 + 搜索图标 + `#searchInput`（`placeholder="搜索地点…"`、`autocomplete=off`）+ `#searchSpin` 加载圈 + `#searchResults` 结果面板（默认 `.hidden`）
- [x] 1.2 `index.html` 新增 `#searchBox` 及子元素 CSS：左上定位（`--safe-l` / `safe-area-inset-top`）、`min(320px, 100vw-28px)` 宽度、加载圈 `spin` 动画、结果条目/分隔/空态样式
- [x] 1.3 `app.js` 在 `initMap` 末尾调用搜索初始化，挂载到已存在的 `map` 与 `#searchInput`
- [x] 1.4 输入事件：防抖 350ms、≥2 字符才触发；<2 字符收起结果并停转加载圈
- [x] 1.5 `keydown` Esc 清空输入并收起；`blur` 延迟 150ms 收起结果面板

## 2. 本地数据集优先检索
- [x] 2.1 新增 `vendor/china-places.js`（省市区三级，3257 条，`window.CHINA_PLACES`，GCJ-02）
- [x] 2.2 新增 `vendor/scenic-5a.js`（5A 景区，358 条，`window.SCENIC_5A`，GCJ-02）
- [x] 2.3 `index.html` 在 `app.js` 之前引入两个数据脚本
- [x] 2.4 本地检索：按名称/路径子串（小写）匹配，最多返回 8 条；结果带层级类型（省份/城市/区县/5A景区）标识

## 3. 在线地理编码降级
- [x] 3.1 主服务 OSM Nominatim（`format=jsonv2&q=&limit=6&accept-language=zh-CN&addressdetails=1`，`AbortController` 5s 超时）
- [x] 3.2 备用镜像地球 `api.mirror-earth.com/nominatim/search`（参数一致，8s 超时）
- [x] 3.3 失败判定：超时/网络错误/HTTP 429 → 降级镜像；主服务可疑时进入 60s 冷却，冷却期内直走镜像
- [x] 3.4 冷却结束恢复优先 OSM（`osmSuspect` 标志随成功/失败切换）

## 4. 合并结果展示与选择跳转
- [x] 4.1 渲染顺序：本地结果在前 + "在线搜索"分隔 + 在线结果在后；空结果显示"无结果"，限流显示"搜索过于频繁"
- [x] 4.2 点击本地结果：`map.setView([lat,lng], zoom)`，缩放按层级（省 8 / 市 11 / 区县 12 / 景区 13）
- [x] 4.3 点击在线结果：WGS84 坐标；`inChina` 为真则 `ExifLite.wgs84ToGcj02(lng,lat)` 纠偏（用返回值 **数组** `[lng,lat]`），缩放 14
- [x] 4.4 选中后回填输入框文字并收起面板、停转加载圈

## 5. 数据缺失降级
- [x] 5.1 `window.CHINA_PLACES` / `window.SCENIC_5A` 任一缺失时 `localData` 为空，仅走在线搜索，不抛错

## 6. 验收
- [x] 6.1 输入"北京""西湖""泰山"等本地结果即时返回并正确飞到对应缩放级别
- [x] 6.2 选中海外在线结果（如 Tokyo）落点无 GCJ02 偏移；国内在线结果有纠偏
- [x] 6.3 断网/OSM 不可达时本地结果仍可用，在线部分转入镜像或给出明确失败提示
- [x] 6.4 `node --check app.js` 语法通过
