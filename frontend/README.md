# frontend/ — Web 客户端

React 19 + Vite + TypeScript + Tailwind + Framer Motion。

- 运行：`npm install && npm run dev`（http://localhost:5173）
- 门禁：`npx tsc -b`（类型检查）+ `npx vite build`
- 源码地图：[src/README.md](src/README.md)（组件与纯逻辑模块的逐文件说明）
- 其余文件：Vite/TS/Tailwind/ESLint 配置（`vite.config.ts`、`tsconfig*.json`、`tailwind.config.js`、`postcss.config.js`、`eslint.config.js`）、`index.html`（挂载点 + favicon）、`public/`（静态资源：应用图标、剧集封面）

## PWA / 离线

- `public/manifest.webmanifest` + `public/pwa-192.png` / `pwa-512.png` / `pwa-maskable-512.png` / `apple-touch-icon.png`：手机浏览器可「添加到主屏幕」；图标由 `hero_icon.png` 生成。
- `public/sw.js`：应用壳 Service Worker。导航 network-first（离线回退缓存的 `index.html`），静态资源 cache-first（Vite dev 下 network-first），`/api/**` 与跨域请求完全不拦截、不缓存；安装/激活时清理旧版本缓存，`skipWaiting` + `clients.claim`。
- 注册在 `src/lib/pwa.ts`（`main.tsx` 调用）。production 和 dev 都会注册；开发时可用 `http://localhost:5173/?dev`（或 `?no-sw`）跳过，避免调试时被缓存干扰。dev 注册的是 `/sw.js?mode=dev`，仅网络优先，不会用旧模块覆盖热更新。
- 安装入口：Chrome/Edge 捕获 `beforeinstallprompt` 显示小按钮（首页/登录页内联，不遮内容）；iOS 显示「分享 → 添加到主屏幕」说明弹窗。离线时左下角显示「当前离线」提示。
- 限制：离线只保证应用壳；登录、字幕生成、历史/复习等依赖后端，断网不可用，也不做任何 API 缓存。iOS 不支持 `beforeinstallprompt`，需走手动添加流程。
- PWA 需要安全上下文（HTTPS 或 localhost）：手机通过局域网 `http://192.168.x.x:5173` 访问时 Service Worker 不会注册。API 默认仍是 `http://127.0.0.1:8000`，真机要正常工作需构建时把 `VITE_API_BASE` 指向电脑的局域网地址（本次未改 API 调用）。

项目全貌与开发规范：根目录 [AGENTS.md](../AGENTS.md)。
