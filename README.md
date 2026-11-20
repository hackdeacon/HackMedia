# AirParser - 全平台无水印媒体解析引擎

基于 **Cloudflare Workers** 打造的现代化、轻量级、无水印全平台媒体解析服务。遵循 [Airbnb DESIGN.md](https://getdesign.md/airbnb/design-md) 规范构建极简响应式 UI，支持全设备端（移动端/平板/桌面）体验。

---

## 🚀 支持的平台与特性

| 平台 | 支持类型 | 核心解析原理与特性 |
| :--- | :--- | :--- |
| **小红书** | 图集 / 高清视频 | 提取 `originVideoKey` 官方无水印源视频直链（4K/1080P，无片尾水印），`fileId` 提取高清无水印原图 |
| **哔哩哔哩** | 完整视频 (MP4) | 解析 `BV` 号及 `cid`，提取官方免登录 `qn=64` 高清合轨 MP4 流，支持断点续传 |
| **抖音 (Douyin)** | 视频 / 图集 | 自动跟随 `v.douyin.com` 短链跳转，提取无水印原画直连（`playwm` -> `play` / `snssdk` 直链） |
| **TikTok** | 视频 / 图集 | 集成 TikWM 免登录引擎，一键获取无水印高清视频直链与音乐 |
| **Twitter / X** | 视频 / 动图 / 图集 | 基于 FixTweet 协议解析，支持多码率原画 MP4 直连与高清原图 |
| **Threads** | 帖子视频 / 大图 | 结合 Twitterbot 开放通道与 Meta GraphQL 架构解析 |

---

## 🛠 本地调试与运行

1. **进入目录并安装依赖**：
   ```bash
   cd /Users/hackdeacon/Desktop/redbook
   npm install
   ```

2. **本地启动 Worker**：
   ```bash
   npx wrangler dev
   ```
   浏览器打开 `http://localhost:8787` 即可实时测试所有平台的分享链接。

---

## 🌐 一键部署至 Cloudflare Workers

1. **登录 Cloudflare**（若尚未在命令行登录）：
   ```bash
   npx wrangler login
   ```

2. **发布上线**：
   ```bash
   npx wrangler deploy
   ```
   发布成功后，Cloudflare 会生成一个全球 CDN 域名（例如 `https://redbook-parser.<你的用户名>.workers.dev`）。

---

## 💡 核心机制说明

1. **全平台防盗链流媒体代理 (`/api/proxy`)**：
   B站、小红书、抖音、Meta 等 CDN 对非官方来源严格校验 HTTP `Referer`。Worker 内置流媒体代理端点，自动重写专属 Referer，支持浏览器在线播放拖拽快进（`Range: bytes=...`），并支持一键另存为下载。
2. **环境变量配置（可选）**：
   如果某些平台在大流量或机房 IP 触发了风控，可在 Cloudflare Worker 控制台或 `wrangler.toml` 中配置环境变量：
   - `REDBOOK_COOKIE`: 小红书登录 Cookie（含 `a1`）
   - `THREADS_COOKIE`: Threads 登录 Cookie
