# OwnTake

把你的想法，拍成你的作品。

OwnTake 是个人电脑上的 AI 短片工作台。Vue 界面、本地 Node 服务、SQLite 与本地媒体文件组成应用；FFmpeg 负责确定性媒体处理。模型和代理运行时通过独立适配器接入。

## 本地启动

要求 **Node.js 24.12+（24.x）**、npm、FFmpeg 与 ffprobe。macOS 可以使用 Homebrew 安装 FFmpeg；在设置页可以填写工具的绝对路径。

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

## 数据与配置

macOS 元数据位于 `~/Library/Application Support/OwnTake/`，项目媒体默认位于 `~/Movies/OwnTake/Projects/`。其他平台默认位于用户应用数据目录。可通过 `OWNTAKE_DATA_DIR`、`OWNTAKE_PROJECTS_DIR`、`OWNTAKE_PORT` 改变位置/端口。指定数据目录时，默认项目目录随其放在 `projects/` 下，便于隔离测试和移动。

所有 HTTP 监听限于回环地址。首次打开建立本地会话，写请求需要 CSRF 验证。请不要将该服务通过反向代理暴露到公网。

## 检查与备份

```bash
npm run check
```

测试使用临时 SQLite、故障夹具及 FFmpeg 生成的小型媒体。不会自动调用收费模型。

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
