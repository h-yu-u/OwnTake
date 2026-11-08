# 子系统责任目录

每个页面拥有一块**当前行为**：入口、合同、关键路径、异常/恢复和验证。架构总览不再重复这些细节。一个行为有一个文档所有者；其他页面只链接。

| 子系统 | 所有的行为 | 首要代码位置 |
| --- | --- | --- |
| [HTTP 与生命周期](http-lifecycle.md) | 服务装配、认证、流、关闭 | `apps/server/src/app.ts`, `bootstrap/`, `http/` |
| [存储与备份](storage.md) | SQLite、资产、事务、升级、恢复 | `packages/storage/` |
| [故事与分镜](stories-storyboard.md) | 故事/剧本版本、镜头、候选、草稿 | `story-repository.ts`, `storyboard.ts` |
| [模型与生成](providers-generation.md) | 能力、凭据、计划、费用、生成状态 | `packages/providers/`, server repositories/runners |
| [媒体与创作工具](media-studio.md) | FFmpeg、时间线、音轨、配音/批量、CLI | `packages/media/`, `packages/runtimes/`, studio |
| [前端](frontend.md) | 导航、编辑状态、API 与可复用交互 | `apps/web/src/` |
| [桌面](desktop.md) | 主进程、preload、核心宿主、系统操作 | `apps/desktop/src/` |

发布产物的责任归属[运维发布](../operations/release.md)。新增子系统时先说明业务边界，再增加当前行为页面；不要只按目录树生成没有维护价值的文件清单。
