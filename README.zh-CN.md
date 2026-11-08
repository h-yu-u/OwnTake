# OwnTake

**把你的想法，拍成你的作品。**

[English](README.md) · [文档导航](docs/README.md) · [开发指南](docs/development/README.md)

OwnTake 是单人、单机使用的 AI 短片工作台。从故事和剧本开始，审阅分镜、导入或生成素材、安排时间线，最终导出 MP4。浏览器和 Electron 桌面端共用 Vue 界面、Fastify 本地服务、SQLite 和 FFmpeg。

## 当前能力

- 故事库、不可变故事/剧本版本、作品来源关联；手动分镜与明确选用的候选素材。
- 模型连接、统一 OpenAI 配置与模型发现、生成台账、费用预留和未知请求核对。
- 图片/视频、配音与批量流程，素材导入、字幕、独立音轨、本地确定性导出及可选 CLI 草稿运行时。
- 隔离的桌面渲染器、原生文件选择、后台任务、有序退出和项目恢复。

模型可用性和能力取决于实际连接。能力声明、模拟测试不代表真实服务或画面质量已经验收；模型建议需审阅。**当前 main 代码不包含可复用人物库**，历史讨论或阶段设计不能代替已实现功能清单。

## 桌面安装包

发布流程声明以下原生目标；只有具体版本中实际存在的产物才表示该版本可下载。

| 系统 | 架构 | 安装包 | 便携归档 |
| --- | --- | --- | --- |
| macOS | Apple Silicon | `owntake-darwin-arm64.dmg` | `owntake-darwin-arm64.zip` |
| macOS | Intel | `owntake-darwin-amd64.dmg` | `owntake-darwin-amd64.zip` |
| Windows | Intel / AMD 64 位 | `owntake-windows-amd64.exe` | `owntake-windows-amd64.zip` |
| Windows | ARM64 | `owntake-windows-arm64.exe` | `owntake-windows-arm64.zip` |
| Linux | Intel / AMD 64 位 | `owntake-linux-amd64.AppImage` | `owntake-linux-amd64.tar.gz` |
| Linux | ARM64 | `owntake-linux-arm64.AppImage` | `owntake-linux-arm64.tar.gz` |

从本仓库 Releases 下载，安装前核对 `SHA256SUMS`，并阅读签名状态。文件名不带版本号，版本由 tag 和清单标识；`amd64` 即 x64，不是仅支持 AMD。打开软件不需要另行下载 JSON 清单。

应用包不包含 FFmpeg、ffprobe、字幕字体或模型密钥，首次使用到设置中配置。未提供发行者证书时，包标为 unsigned / ad-hoc，**不等于 Windows 可信签名或 Apple 公证**。详见[安装与发布说明](docs/operations/release.md)。

## 从源码启动

准备 **Node.js 24.12+（24.x）**、npm、FFmpeg、ffprobe；字幕使用覆盖目标文字的字体，FFmpeg 需支持 libass。

```sh
npm ci
npm run build
npm start
```

访问 `http://127.0.0.1:4317`。桌面端使用 `npm run desktop`。开发、检查和本机构建命令见[开发指南](docs/development/README.md)。

## 数据与安全

项目、素材保存在本机；调用外部模型时会发送选定的提示词和素材。本地应用不代表始终离线。服务只监听回环地址，不应作为公网服务部署。

macOS 元数据默认在 `~/Library/Application Support/OwnTake/`，项目默认在 `~/Movies/OwnTake/Projects/`。其他平台继续使用既有 XDG/用户目录布局，不在升级中静默搬迁。API Key 保存在受限权限的本地明文文件，应用本身不加密，且不进入项目备份。移动数据前阅读[配置与备份](docs/operations/data-and-configuration.md)。

关闭桌面窗口会继续后台处理，明确退出应用才停止本地核心。付费请求状态不明时先核对原请求，不把重新生成当成网络重试。

## 参与维护

先读 [AGENTS.md](AGENTS.md)、[代码规范](docs/code-standards.md) 和对应[子系统文档](docs/subsystems/README.md)。执行 `npm run check`；桌面相关改动需补原生打包冒烟。PR 写明实际验证与未验证项。版本工作流创建 Release 草稿，不自动向用户公开发布。
