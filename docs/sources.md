# 资料与设计依据

> 核验日期：2026-11-06。本文区分外部工具事实与 OwnTake 自己的设计选择。供应商文档会更新，接入时须重新核验具体模型、端点、API 版本和账户权限。

## 官方参考资料

| 资料 | 在本项目中的用途 | 使用边界 |
| --- | --- | --- |
| [Vue：Quick Start](https://vuejs.org/guide/quick-start)；[TypeScript](https://vuejs.org/guide/typescript/overview) | Vue 单页应用、Vite 与 TypeScript 的工程入口 | P1 实施时锁定兼容 Node / Vue / Vite 版本；静态原型不是 Vue 应用 |
| [Node.js：child_process](https://nodejs.org/api/child_process.html) | 用异步子进程调用媒体工具和可选 CLI；处理环境变量、标准输出和退出状态 | 通过结构化参数调用；不能把提示词拼成 shell 命令，必须持续消费有界日志 |
| [SQLite：Appropriate Uses](https://www.sqlite.org/whentouse.html) | SQLite 适合应用本地数据存储，支持本项目的单机部署选择 | 不据此承诺高并发服务能力；OwnTake 主动保持较低写入并发 |
| [SQLite：WAL](https://sqlite.org/wal.html) | 读写并发、检查点与备份时的一致性考虑 | WAL 依赖同机共享内存；活动数据库放本地磁盘，不能直接把活动库作为网络盘上的共享文件 |
| [FFmpeg：Filters](https://ffmpeg.org/ffmpeg-filters.html) | 缩放、裁切、字幕、文本、音频及组合滤镜 | 可用滤镜取决于安装的构建选项；P1 检查实际编码器和滤镜，后续阶段再检查新增需求 |
| [Electron：Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) | 桌面壳的主进程、渲染进程与应用生命周期 | Electron 仅为 P5 选项；原生能力通过受限桥接提供给前端 |
| [Claude Agent SDK：Overview](https://code.claude.com/docs/en/agent-sdk/overview) | 区分直接模型 API 与带工具、权限、会话的 Agent Runtime | 不把 Claude Code / Agent SDK 当作任意模型的 base URL；实际认证及可用能力在 P4 验证 |
| [Codex：Non-interactive mode](https://developers.openai.com/codex/noninteractive) | 可选非交互运行时适配的参考入口 | 不依赖终端屏幕抓取；接入时验证已安装版本、机器可读事件、认证与退出行为 |
| [火山方舟：创建视频生成任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)；[视频生成教程](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=zh) | 视频任务、首帧 / 首尾帧与参考输入等能力的核验入口 | 能力属于具体模型和任务模式；不能把某个型号的约束推广给所有 Seedance 模型 |
| [Runway：SDKs](https://docs.dev.runwayml.com/api-details/sdks/)；[API Reference](https://docs.dev.runwayml.com/api/) | 异步任务、轮询及取消语义的另一种实现参考 | 停止客户端等待与取消远端任务分别建模；收费和取消以实际 API 及账单为准 |

这些资料支持工具能力及适配边界。选择本地 Web、SQLite 小队列、分阶段交付和人工选择候选，是为 OwnTake 当前单人自用范围作出的设计判断，不是供应商要求。

## 原始讨论背景

用户提供了 [EianLu 的原始帖子](https://x.com/EianLu/status/2118317430665613741)，并提出将 CC、Codex、Seedance 的职责拆开，通过能力适配接入其他模型。OwnTake 沿用“创意到成片”的流程意图，独立设计了本地应用、版本系统与可靠任务机制。

本仓库不将帖子内容作为模型 API 合同，不复制长篇提示词或第三方文档。具体实现以官方接口与实际契约测试为准。

## 接入真实供应商时记录什么

为每个 `provider + endpoint + API version + model` 维护一份可追溯的能力清单，至少记录：

1. 官方文档 URL、读取日期、账户或地域前提，以及配置的准确模型 ID。
2. 输入模式与条件约束：尺寸、时长、参考类型与数量、首尾帧、音频输入和音频输出分别说明。
3. 请求编译和验证结果；不支持的组合要明确拒绝或提出新的镜头方案。
4. 异步状态、可查询标识、上游幂等支持、取消限制与下载链接生命周期。
5. 估价公式及版本、价格信息是否过期；估算、预留、实付和无法确认的费用分开。
6. 已通过的契约测试与未验证能力；“文档声明支持”不自动等于“本地已验证”。

不得在前端枚举里硬编码一个长期有效的“所有视频模型都支持”的能力集合。第一版只需把实际会使用的供应商接稳；第二种能力不同的模拟适配器可以用来验证可替换性，真实第二供应商按需要再接。

## 仍需在实施时决定

| 项目 | 当前设计基线 | 决定时点 |
| --- | --- | --- |
| Node 与包版本 | 使用依赖组合支持的 LTS，锁文件固定版本 | P1 开始 |
| HTTP / SQLite 库 | 保持轻量；接口与存储逻辑隔离 | P1 开始，并记录实际选择 |
| 实际模型和账户 | 按用户已有可用端点及样片质量选择 | P2 推理接入、P3 图像 / 视频接入 |
| 自动任务预算 | 默认保守，用户可在项目策略内设上限 | 首次真实付费调用前 |
| 外部运行时 | Native 先实现；CC / Codex 可选 | P4 有真实需求时 |
| 桌面封装 | 本地 Web 已能独立使用；Electron 可选 | P5，有启动体验需求时 |

这些选择不会改变当前已确定的本地部署、分镜版本管理、三类适配器及安全重试边界。
