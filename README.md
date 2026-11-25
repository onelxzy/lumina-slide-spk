<div align="center">
  <img src="public/icon.svg" width="112" alt="LuminaSlide Logo">
  <h1>拾光轮播 · LuminaSlide</h1>
  <p>面向海量图库的轻量级随机轮播与画廊播放器<br>洗牌袋无重复随机 · 服务端等比降采样 · 本地与 WebDAV 混合 · 群晖 DSM 7 套件</p>
</div>

---

## 核心特性

- **海量图库专用架构**：服务端通过 `ffmpeg` / `ImageMagick` 按包围盒等比降采样输出（默认 WebP），保持宽高比且不放大小图，彻底避免客户端解码大图卡死。
- **严格并发与防雪崩**：转码进程数受信号量硬限制，配合请求去重与失败黑名单机制，遇到异常或风控文件自动跳过，绝不无限重试。
- **真随机洗牌袋**：每轮使用 `crypto.randomInt` 生成种子进行 Fisher-Yates 洗牌，一轮内绝不重复并支持断点续播；同时支持纯随机、弱去重及「按相册均分」公平性策略。
- **真增量索引扫描**：区分叶子目录与含子目录的父目录，叶子目录 `mtime` 未变时直接跳过，父目录变化时自动清理已删除的文件与子目录；全量重建采用 Mark & Sweep 机制，中途取消不破坏现有索引。
- **轻量零写盘缓存**：默认采用「张数 + 字节容量」双封顶纯内存 LRU（默认 64 MB），避免频繁写盘并杜绝 OOM；支持按需开启磁盘二级缓存。
- **多端适配与画中画**：支持键盘、电视遥控器与触屏手势；支持无边框视频画中画（带原生上一张 / 暂停 / 下一张控制）与多端 WebSocket 实时同步。
- **可选访问控制**：支持启用登录验证（`scrypt` 加盐哈希 + `HttpOnly` 签名会话 + 登录限流），内网可按需关闭，公网反代部署更安全。

## 目录结构

```text
lumina-slide-spk/
├── .github/workflows/
│   └── release.yml              # Tag 触发自动校验并构建 SPK
├── defaults/
│   └── config.default.json      # 默认配置模板
├── public/                      # 原生 HTML / CSS / JS 前端（零构建依赖）
│   ├── index.html / app.js / app.css
│   ├── admin.html / admin.js / admin.css
│   ├── login.html
│   └── icon.svg
├── package/                     # 群晖 DSM 7 套件描述与生命周期脚本
│   ├── INFO
│   ├── PACKAGE_ICON*.PNG
│   ├── WIZARD_UIFILES/
│   ├── conf/
│   ├── scripts/
│   └── ui/
├── src/                         # Node.js 后端（零外部 npm 依赖）
│   ├── server.js                # HTTP 服务与路由
│   ├── auth.js                  # 登录认证与会话管理
│   ├── ws.js                    # WebSocket 广播中心
│   ├── config.js                # 配置加载与热更新
│   ├── sources.js               # 本地与 WebDAV 数据源抽象
│   ├── scanner.js               # 真增量 / 全量重建扫描器
│   ├── randomizer.js            # 洗牌袋与播放历史调度
│   ├── pipeline.js              # 信号量并发控制与 LRU 缓存管线
│   └── store.js                 # node:sqlite 索引与收藏存储
├── build.py                     # 跨平台 DSM SPK 打包脚本
├── package.json
└── LICENSE
```

## 安装与使用

### 依赖

套件在 `INFO` 中通过 `install_dep_packages` 声明了依赖，DSM 套件中心会在安装时自动检查并提示安装缺失项：

| 依赖 | 包名 | 说明 |
|---|---|---|
| Node.js 22 | `Node.js_v22` | 后端运行时（代码兼容 v18/v20/v22） |
| ffmpeg | `ffmpeg8` | 服务端转码与降采样（代码兼容 ffmpeg6/7/8） |

> 若套件中心未自动安装，请手动从「套件中心 → 社群」安装 SynoCommunity 的 **ffmpeg8**。

### 方式一：群晖 DSM 套件中心（推荐）

1. 前往 [Releases](https://github.com/onelxzy/lumina-slide-spk/releases) 下载最新的 `LuminaSlide_*_all.spk`。
2. 确保上述依赖已安装（套件中心会自动提示）。
3. 打开 DSM「套件中心 → 手动安装」，上传 `.spk`（默认 HTTP 端口 `18666`，可在安装向导中自定义）。
4. 启动套件后点击「打开」，或访问 `http://<NAS-IP>:18666/admin` 添加本地路径 / WebDAV 来源并执行索引扫描。

访问 `http://<IP>:18666/`（播放页）或 `http://<IP>:18666/admin`（配置页）。

## 从源码构建 SPK

需要 Python 3.10+（纯标准库，无额外依赖）：

```bash
python3 build.py 1.0.2
```

产物将生成在 `dist/LuminaSlide_<version>_all.spk`。推送 `v*` 标签（如 `git tag v1.0.2 && git push origin v1.0.2`）时，GitHub Actions 会自动执行语法检查、构建并发布 Release。

## 开源协议

基于 [MIT License](LICENSE) 开源。
