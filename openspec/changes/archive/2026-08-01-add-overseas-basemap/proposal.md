## Why
高德公共瓦片仅覆盖国内，海外区域显示为空白；当照片点位落在境外时，用户看不到任何地图底图，缩略图悬在空白背景上，体验严重受损。需要在不引入 API Key、不破坏国内既有精度的前提下，让海外区域也有可用底图。

## What Changes
- 新增海外底图配置：标准图用 OSM、卫星图用 Esri World Imagery、标注用 Esri World Boundaries and Places（均为 WGS84、免 Key、全球覆盖）
- 新增地图中心点国内/海外自动判定：平移或缩放结束后，按中心点经纬度判定区域，自动切换国内（高德）↔ 海外（全球瓦片）底图
- 重构底图切换逻辑：原 `toggleLayer` 直接增删图层，现统一收敛为 `applyBasemap()`，按「国内/海外 × 标准/卫星」四象限组合切换
- 海外照片点位不做 GCJ02 纠偏：境外 `outOfChina` 为真，天然与 WGS84 海外瓦片对齐
- 新增本地优先、远端兜底的自定义瓦片层（`offlineTileLayer`），为未来离线下载预留
- **离线瓦片下载功能代码保留但默认禁用**：UI 弹窗、按钮、下载流程均以注释形式保留，需将 OSM 源替换为支持 CORS 的源（如 CARTO Voyager）并取消注释后才能启用
- 切换区域时弹出 Toast 提示当前底图来源

## Capabilities
### New Capabilities
- `overseas-basemap`: 海外区域底图自动选择与切换，覆盖区域判定、底图来源切换、标准/卫星双模式、坐标对齐策略

### Modified Capabilities
<!-- 既有 specs/ 为空，本次为项目首个 capability，无修改项 -->

## Impact
- **代码**：`app.js`（initMap、toggleLayer 重构、新增 inChina/applyBasemap/detectRegion/offlineTileLayer 及注释保留的离线下载代码块）、`index.html`（新增 `.prog-cancel` 样式、注释保留的离线下载 UI）
- **依赖**：新增对外部瓦片服务的运行时依赖（OSM、Esri），无第三方库引入
- **行为**：海外区域从"空白"变为"显示全球瓦片"；切换区域有 Toast；标准/卫星切换在海外同样生效
- **风险**：OSM/Esri 为远端服务，海外网络访问可能不稳定；离线下载因 CORS 默认禁用
