# 多平台构建与发布

## 单一配置源

[targets.mjs](../../scripts/release/targets.mjs) 是平台、原生 runner、内部架构、格式、公开文件名的唯一注册表。构建、CI 矩阵、清单和完整性检查消费它；不要在 workflow 中维护另一份平台矩阵。命名借鉴 Magpie 的 `产品-系统-架构`，而不是复制其非 Electron 实现。

| 目标 | 格式 | 公开文件名 |
| --- | --- | --- |
| `darwin-arm64` | DMG / ZIP | `owntake-darwin-arm64.dmg` / `.zip` |
| `darwin-amd64` | DMG / ZIP | `owntake-darwin-amd64.dmg` / `.zip` |
| `windows-amd64` | NSIS EXE / ZIP | `owntake-windows-amd64.exe` / `.zip` |
| `windows-arm64` | NSIS EXE / ZIP | `owntake-windows-arm64.exe` / `.zip` |
| `linux-amd64` | AppImage / tar.gz | `owntake-linux-amd64.AppImage` / `.tar.gz` |
| `linux-arm64` | AppImage / tar.gz | `owntake-linux-arm64.AppImage` / `.tar.gz` |

Electron `x64` 对应外部 `amd64`；`darwin` 表示 macOS。文件名稳定且不含版本号，版本和源提交由 tag、产物清单明确标识。消费者只需对应安装包；清单用于审计，不是打开软件的依赖。

## 构建与原生验收

[原生工作流](../../.github/workflows/desktop-packages.yml) 在每个目标本机运行。先装系统工具，再固定 Node 24 与正确 CPU 架构。应用包仅包含构建后的三端入口/网页及必要元数据，不含源码仓库、用户数据库、密钥、字体或独立 FFmpeg 程序。

`package:desktop` 要求已提交的干净源码，调用 electron-builder 的统一配置，显式 `publish: never`。使用已安装且核验版本/二进制架构的本机 Electron，避免重复下载同一发行包。每个目标输出两份产物与其 SHA256/大小清单。

`smoke:package` 解包实际 ZIP/tar.gz，检查 ELF/PE/Mach-O 的 CPU 架构，并启动解包后的真实 Electron 程序，验证生命周期与持久化，不使用开发版本替代。成功后只把本次产物与清单放入待聚合目录。Linux 需图形环境/Xvfb。

最后 `release:assemble` 要求六个目标、十二个产物全齐，版本/提交一致，原生 smoke 已通过且摘要匹配；缺件、重名、多余文件、混版本或损坏均阻止发布。输出 `SHA256SUMS`、`release-manifest.json` 和中英 Release notes 草稿。

## 签名与系统信任

PR 构建不传签名/发布密钥。可信发布可在仓库 Secrets 配置：

| 平台 | 配置 | 未配置时 |
| --- | --- | --- |
| macOS | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | ad-hoc 签名、不公证 |
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | unsigned，无发行者 Authenticode 信任 |
| Linux | 本流程只提供文件 SHA256 | 不声称发行者数字签名 |

macOS 证书/公证只配置一部分时失败而不降级。清单及说明明确实际签名模式；有成功构建不等于通过 Gatekeeper/SmartScreen。不要指导用户全局关闭安全功能。可信签名、安装器 UI、卸载/升级及目标用户机器仍需独立验收。

## 发布步骤

1. 审阅 PR、所有原生检查与用户可感知的版本变化；确认合入 main。
2. 按 SemVer 更新 package.json 和 lockfile，提交并验证。签名密钥不进提交。
3. 维护者明确决定发布后创建 `v<package.json version>` tag。也可用手动工作流选择已存在的同名 tag。
4. [Release draft workflow](../../.github/workflows/release.yml) 验证 tag 与包版本完全一致，源提交属于 main；从同一提交构建并聚合所有产物，最后创建 **draft**。
5. 在草稿中用具体新增/修复/升级注意替换占位说明，复核签名、摘要和安装器验收，再人工发布。

这次仓库重构只增加流程，不创建版本 tag，不代表已经向用户发布。工作流拒绝覆盖已有 release，不使用 clobber 自动替换旧资产。失败时保留诊断，修复后针对对应源版本重跑；不要把其他提交构建的单个平台包拼到同一 release。

## 验收边界

CI 的“原生通过”是对应 runner 上的类型/工具检查、构建、可执行文件架构和归档启动/生命周期验证。它不自动证明所有 Linux 发行版、Windows 安装向导、DMG 拖拽安装、系统信任证书或收费模型可用。FFmpeg、ffprobe、字幕字体、模型凭据由最终用户配置；测试字体只下载到 CI 临时目录，不进入应用包。
