# OwnTake

把你的想法，拍成你的作品。

OwnTake 是个人电脑上的 AI 短片工作台。Vue 界面、本地 Node 服务、SQLite 与本地媒体文件组成应用；FFmpeg 负责确定性媒体处理。模型和代理运行时通过独立适配器接入。

## 本地启动

要求 **Node.js 24.12+（24.x）**、npm、FFmpeg 与 ffprobe。macOS 的字幕导出需要包含 libass 的 FFmpeg；可安装 [Homebrew ffmpeg-full](https://formulae.brew.sh/formula/ffmpeg-full)，并在设置页选择其 `bin/ffmpeg`、`bin/ffprobe` 绝对路径及中文字体。

```bash
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。关闭网页不会停止服务；终端中的 `Ctrl+C` 会有序停止服务，未完成的本地渲染可在下次启动恢复。

开发模式：

```bash
npm run dev
```

打开 <http://127.0.0.1:5173>。前端代理请求到本地服务；无需配置数据库服务或 Docker。

## 桌面启动与打包

复用同一套数据与功能，也可以从桌面窗口使用：

```bash
npm run desktop
```

在 Mac 上执行 `npm run package:mac` 生成 `release/` 中的个人自用 ZIP，解压即可运行内置 Node 的应用。FFmpeg、字体和可选 CLI 仍由本机配置。关闭窗口继续后台运行；应用菜单中的退出会协调停止任务。相同数据目录已有 Web 服务时，先停止该服务再启动桌面入口。桌面部署、升级快照及验收边界见 [P5 说明](docs/validation/p5.md)。

## 数据与配置

macOS 元数据位于 `~/Library/Application Support/OwnTake/`，项目媒体默认位于 `~/Movies/OwnTake/Projects/`。其他平台默认位于用户应用数据目录。可通过 `OWNTAKE_DATA_DIR`、`OWNTAKE_PROJECTS_DIR`、`OWNTAKE_PORT` 改变位置/端口。指定数据目录时，默认项目目录随其放在 `projects/` 下，便于隔离测试和移动。

所有 HTTP 监听限于回环地址。首次打开建立本地会话，写请求需要 CSRF 验证。请不要将该服务通过反向代理暴露到公网。

## 检查与备份

```bash
npm run check
```

测试使用临时 SQLite、故障夹具及 FFmpeg 生成的小型媒体。不会自动调用收费模型。
媒体验收需要真实中文字体：Linux 可安装 `fonts-noto-cjk`，或将 `OWNTAKE_TEST_FONT` 指向包含中文字形的字体文件；macOS 测试优先使用系统 PingFang。

停止应用后，设置相同数据目录并执行：

```bash
npm run backup -- create /absolute/path/to/new-backup
```

恢复到**空的**目标数据与项目目录：

```bash
OWNTAKE_DATA_DIR=/absolute/path/to/new-data npm run backup -- restore /absolute/path/to/new-backup
```

备份包含数据库快照和所引用的不可变媒体。模型凭据不应放在项目或提交到 Git。

## 设计与交付

[文档入口](docs/README.md) · [架构](docs/architecture.md) · [实施计划](docs/implementation-plan.md) · [原始交互原型](docs/prototype/README.md)

开发按 P1–P5 分阶段交付；每阶段的实际验证和限制记录在 `docs/validation/`。原型与正式程序分开，原型中的模拟状态不用于证明正式功能已经实现。

## 分镜与可选推理

「分镜」支持手工镜头、候选选择、版本和修改草稿；「设置」可添加支持严格 JSON Schema 的 Chat Completions 连接。模型建议需逐项审阅后应用。推理调用前会冻结简报/分镜版本并预留用户填写的额度，响应不明不自动重发；金额不等于供应商账单。实际配置要求和流程见 [P2 说明](docs/validation/p2.md)。

本地凭据保存在应用数据目录的 `provider-credentials.json`，权限为 0600；它不进入 Git 或项目备份。迁移机器时需单独安全保存凭据，或重新配置连接。

## 图片、视频与成片

设置中可添加 OpenAI Images 或 Ark 视频协议连接；在分镜中审阅计划与额度后生成候选，明确选择版本，再保存到时间线。字幕、独立音轨、增益与淡入淡出都在本地确定性合成。任务页提供原任务查询、未知状态核对、原下载恢复及费用记账，重复请求不会被当作网络恢复。详细限制、取消语义和验证记录见 [P3 说明](docs/validation/p3.md)。

## 可选创作工具

「创作工具」提供独立配音素材、带证据帧的画面抽样审核，以及 Claude Code / Codex 本机草稿运行时。模型能力由连接声明，CLI 默认关闭并需要在本机配置与启用；产生的草稿仍需逐项接受。完整回复先持久化再入库，未知提交不自动再调用。设置与实际边界见 [P4 说明](docs/validation/p4.md)。
