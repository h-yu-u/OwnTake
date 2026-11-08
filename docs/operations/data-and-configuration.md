# 数据、配置、备份与排错

## 目录与配置

权威配置在 [server.ts](../../apps/server/src/config/server.ts)，不要在文档维护另一套默认值。现有 macOS 元数据位于 `~/Library/Application Support/OwnTake/`，项目位于 `~/Movies/OwnTake/Projects/`。其他平台使用 `XDG_DATA_HOME/owntake`，未设置时为 `~/.local/share/owntake`；项目默认是数据目录中的 `projects/`。

指定 `OWNTAKE_DATA_DIR` 时默认项目目录随之放置；`OWNTAKE_PROJECTS_DIR` 可单独指定。`OWNTAKE_PORT` 控制 Web 端口，`OWNTAKE_LOG_LEVEL` 控制结构化日志。桌面宿主为自身服务选择动态回环端口。升级不会自动搬迁旧目录。

FFmpeg、ffprobe、字幕字体和可选 CLI 通过设置配置。工具路径以实际可执行文件为准；从 Finder/Windows 桌面启动的环境不一定包含交互式 shell 的 PATH。

## 密钥

API 密钥由本地服务保管，受限权限文件不等于应用级加密。不要上传到 Git、共享项目、诊断截图或发布包。迁移设备时重新配置或通过独立安全渠道迁移；普通项目备份不携带凭据。

## 备份与恢复

先正常退出桌面应用/停止 Web 服务，确认没有另一个进程持有数据目录。

```sh
npm run backup -- create /absolute/path/to/new-backup
```

恢复到**空目录**，设置相同的目标配置后执行：

```sh
OWNTAKE_DATA_DIR=/absolute/path/to/new-data npm run backup -- restore /absolute/path/to/new-backup
```

Windows PowerShell 用 `$env:OWNTAKE_DATA_DIR = 'C:\path\new-data'` 设置环境，再执行 backup 命令。指定独立媒体目录时同时设置 `OWNTAKE_PROJECTS_DIR`。

完整备份包括一致数据库与引用媒体及摘要。迁移前自动快照仅保护数据库，不替代全量媒体备份。不要运行中只复制 `app.sqlite` 忽略 WAL；不要把恢复覆盖到已有目录。旧应用无法理解更高 Schema 时应停止写入，按记录使用匹配版本或经过验证的完整恢复。

## 常见故障

| 表现 | 检查方式 |
| --- | --- |
| 服务未就绪或实例锁冲突 | 确认 Web/桌面没有同时使用同一数据目录；正常退出持锁进程，先看日志而非直接删锁 |
| FFmpeg/字幕不可用 | 检查设置中的绝对路径、ffprobe、libass 和字体覆盖；不要把缺字当作模型问题 |
| 素材缺失或摘要不符 | 恢复原文件；不同内容应作为新素材导入，不能覆盖旧资产 |
| 模型提交超时 | 查原调用/任务记录，核对供应商状态，不直接重新生成 |
| 安装包无法启动 | 确认 OS/架构、文件摘要、签名状态和解包是否完整；不要全局关闭系统安全保护 |
| Linux AppImage 启动环境问题 | 检查发行版对 FUSE/图形会话的支持，或使用同架构 tar.gz；不声称覆盖所有发行版 |

记录故障时给出应用版本、OS/架构、动作和脱敏错误；不要公开 API Key、含私人信息的故事或完整媒体目录。
