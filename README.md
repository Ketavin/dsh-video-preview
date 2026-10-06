[![dshfind](https://dshfind.com/api/badge/zemul/dsh-video-preview?lang=zh)](https://dshfind.com/zh/plugins/zemul/dsh-video-preview?ref=badge)

> 📌 本插件已收录于 [dshfind](https://dshfind.com/zh) 插件超市（GitHub 仓库打 `dsh-better-sidebar` / `dsh-plugin` topic 后自动收录），点击上方徽章直达主页。

# dsh-video-preview

此 checkout 为 DSH Core 0.1.1-rc.2 / Better Sidebar 0.17.8 的隔离适配候选，版本
`0.1.4-arist.p4.1`。尚未正式发布；不应直接覆盖正在运行的 Profile。

[![npm version](https://img.shields.io/npm/v/dsh-video-preview)](https://www.npmjs.com/package/dsh-video-preview)

[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的视频文件预览插件：
在侧边栏打开 `.mp4` / `.webm` / `.mov` / `.mkv` / `.avi` 等视频文件时，内联渲染一个可播放、可拖拽进度条的 `<video>` 播放器。

## 背景

better-sidebar 内置的文件预览器只有 image / pdf / markdown / html / code / binary-download，
**没有视频预览**——视频文件目前会落到 code 视图（乱码）或下载按钮。

直接复用内置的 `/sidebar/file` 媒体路由也不行：

- 该路由**不支持 HTTP Range**（整个文件读进内存、返回 `200`），浏览器无法拖动进度条（seek）；
- 受 `mediaLimit`（默认 20MB）限制，更大的视频会被直接拒绝。

因此本插件自带一条 **支持 Range（206 Partial Content）的 `/video/*` 宿主路由**，
用 `createReadStream` 分片流式下发，seek / 拖进度条 / 倍速都能正常工作。

## 功能

- 通过 `ctx.betterSidebar.registerFileViewer` 注册 `video` 预览器（id `video`，与内置 viewer 同权）：
  - `.mp4/.m4v/.webm/.mov/.qt/.mkv/.avi/.wmv/.flv/.ogv/.ogg/.mpeg/.mpg/.3gp/.3g2/.m2ts`
  - 内联 `<video controls>`：播放/暂停、拖进度条（Range 206）、倍速、全屏、音量、`preload=metadata`
  - 底部文件名 + 「下载」链接（浏览器无法解码的容器格式仍可下载原文件）
- 自带 `/video/*` 宿主路由：单段 HTTP Range / suffix-range（`bytes=-N`）；
  下载也使用流式路由，大小不受 `mediaLimit` 限制。HEAD 忽略 Range；多段或未知单位返回完整 200；
  无法确认强校验器的 If-Range 请求保守返回完整 200；无效/不可满足的单段范围返回 416。
- viewer 描述符带 `title`/`icon`，Side card 设置页自动显示启用开关（含 16px 播放器图标）
- 客户端组件自包含：不依赖 better-sidebar 的 client 内部实现，`fetchStrategy: 'none'`

## 依赖 better-sidebar 版本

需要 better-sidebar `>= 0.4.0`（`ctx.betterSidebar.registerFileViewer` 服务）。

适配版宿主还需要 `sessions`、`sessionPersistence`、`webServer` 与 `webRuntime`。
已连接会话和未连接的持久会话均由 Host 决定工作目录，浏览器提供的 cwd 不授予读取权限。

## 安装（profile）

前置：DSH 已装好且 `dsh web` 能运行，已安装 `dsh-better-sidebar`。

```sh
# 从 npm 安装（推荐，发布后生效）：
dsh plugin --profile web add dsh-video-preview

# 本地开发（link: 热更新）：
dsh plugin --profile web add "link:<本目录>"

# 从 tarball 安装（离线 / 未发布）：
dsh plugin --profile web add file:<本目录>/dsh-video-preview-0.1.1.tgz
```

安装后重启 `dsh web` 进程并浏览器硬刷新（`Cmd/Ctrl+Shift+R`）。
> 说明：新增宿主半（`/video` 路由）需要重启一次；之后仅 client 改动硬刷新即可。

## 运行

- 打开侧边栏 → 在文件资源管理器中打开任意视频文件，`video` 预览器自动命中；
- Side card 设置页 →「文件预览」清单中可见 `Video` 卡片（带播放器图标），可单独启用/禁用。

## 开发与检查

```sh
node test/route.test.mjs   # 宿主路由回归测试（Range/206/416/403/HEAD/405，19 项）
node --test test/boundaries.test.mjs # 权威目录、越界链接、范围边界、大文件、断连及信任边界
```

| 检查项 | 命令 | 预期 |
|--------|------|------|
| 宿主路由测试 | `node test/route.test.mjs` | 全部通过 |
| client bundle | `node --check client.js` | 语法 OK |
| bundle 形态 | 产物首行 | `window.__ModuleLoader__.load({ id: 'dsh-video-preview', ... })` |
| 安装状态 | `node_modules/dsh-video-preview/client.js` 存在 | True |

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半：注册 `/video/*` 前缀路由（Host 信任围栏、权威会话目录、单段 Range 与流式下载） |
| `client.js` | 客户端 bundle：经 `ctx.betterSidebar.registerFileViewer` 注册 `video` 预览器（`fetchStrategy: 'none'`，含 16px 图标） |
| `cordis.patch.yml` | `dsh.bundle.patch`：挂载行（entry `name` 与包名一致，供 client-modules 发现 client bundle） |
| `test/route.test.mjs` | 宿主路由回归测试（自包含，无需 ffmpeg） |

## 安全

- 路由复用与 `/api` 网关相同的 Host 头信任围栏（loopback 或 `trustedHosts`，拒绝跨站）；
- 路径须同时通过词法与 realpath 规范路径检查，拦截指向目录外的链接；Windows 禁止 ADS；
- 流式读取已打开的文件句柄；这不能代替防御恶意本机进程并发改写文件系统的 OS 沙盒；
- 只读流式下发，不写文件、不设身份。

## 说明与限制

- 支持浏览器可解码的容器/编码（H.264 的 mp4/m4v、VP8/VP9 的 webm、mov、OGV 等）；
  Chrome/Edge/Firefox 不内置解码的格式（如部分 HEVC、AV1 组合）会在播放器内报错，可用「下载」取回原文件；
- 视频大小不受 better-sidebar `mediaLimit` 限制；
- 播放失败显示提示并保留下载；关闭预览时暂停并释放媒体源。取消传输关闭文件流；
- 注册容器扩展名不代表浏览器具有所有相关解码器，首轮真实 Chromium 已验证 VP8 WebM；
- 不新建 Tab 页，仅作为文件预览器注册（也可按需再加 `registerTab`）。

## 许可证

[MIT](./LICENSE)
