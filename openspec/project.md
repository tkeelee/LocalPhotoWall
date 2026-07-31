# LocalPhotoWall 项目上下文

## 项目目标
单机版纯前端网页照片地图：导入本地照片（含子目录），读取 EXIF GPS，在地图上以缩略图标记展示，支持标准/卫星模式切换、时间轴播放、加载数据库。PC 与移动端浏览器通用。

## 技术栈与架构约束
- 纯静态站点：`index.html` + `app.js` + `exif.js` + `vendor/`（Leaflet、sql.js）
- 地图：Leaflet + 高德公共瓦片（免 Key，仅覆盖国内）
- 存储：sql.js（SQLite WASM）；`file://` 协议走 `sql-asm.js`，HTTP 走 `sql-wasm.js`
- 照片去重：基于内容哈希
- 无后端、无构建步骤、无外部 Key

## 关键限制
- 高德公共瓦片仅覆盖国内，海外区域为空白
- 海外照片点位为 WGS84 坐标，国内高德瓦片为 GCJ02；exif.js 的 `outOfChina` 判定境外时不做偏移
- `file://` 下浏览器禁止自动写盘，需用户手动选择目录或点击"保存数据"
- 浏览器安全策略限制 `fetch` 本地文件，跨域瓦片源需支持 CORS 才能离线下载

## 代码风格
- 原生 JavaScript（ES5 兼容），无模块系统
- 全局命名空间内单一 IIFE 包裹
- 注释使用中文
