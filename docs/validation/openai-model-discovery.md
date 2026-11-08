# OpenAI 账号模型发现

## 解决的问题

统一连接的第一版每类下拉只放了一个预设，容易被误认为账号只能使用该模型。模型选择现在由账号目录、官方预设和手动填写共同支持。

在「设置 → OpenAI → 管理连接 → 模型与高级设置」展开模型区时，有凭据即可读取账号模型；也可点击读取 / 刷新按钮。已有连接使用本地保存的 Key，新填写的 Key 只用于本次读取，点击保存连接之前不会持久化或轮换凭据。

账号列表按用途分组并支持搜索；未知名称保留在待确认用途的组中。当前选中模型始终保留，刷新不会自动替换选择。尚未读取、读取失败或当前值未在列表中出现时，用户仍可使用预设或手填 ID。更改 Key、切换连接或关闭弹窗会使旧请求失效，避免迟到响应混入另一个账号的目录。

## 默认值与用途

2026-11-08 重新核对官方模型目录与 API 指南后，新建连接默认使用：

| 能力 | 默认模型 | 其他预设示例 |
| --- | --- | --- |
| 分镜 / 画面审核 | `gpt-6.1-sol` | `gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`，并保留部分 GPT-5 系列 |
| 图片 | `gpt-image-2.6-flare` | `gpt-image-2.6-sunburst`、2.5 系列、`gpt-image-2` |
| 配音 | `gpt-4o-mini-tts` | `tts-1`、`tts-1-hd` |

预设只表示应用提供的候选，不证明某个 Key 有访问权限。账号目录成功读取时，显示该次返回的候选与用户当前值，不把预设伪装为账号已授权模型。旧连接、已排队任务和已冻结请求不会自动迁移到新默认模型。

GPT-6 / 6.1 的纯文字 / 图像输入与严格 JSON 输出可复用当前 Chat Completions 流程。GPT Image 2.6 支持现有 PNG 与 1536×864、864×1536、1024×1024 尺寸。Realtime、转录、embedding、Codex 专用和 Pro 等其他端点用途不因出现在账号列表里就成为现有三项能力的候选。当前配音仍使用 Speech API，其已公告生命周期见 [统一连接说明](openai-connection.md)。

## 边界与实现

`POST /api/openai-connections/models` 接受 `{ connectionId?: string, key?: string }`，沿用本地会话与 CSRF 保护。不接受 Base URL 或凭据引用，服务端只向 `https://api.openai.com/v1/models` 发送一次 GET；禁用重定向，不调用生成接口。

- 应用用例：`apps/server/src/application/openai.ts` 解析输入并在服务端读取凭据，不写数据库或 vault。
- 供应商客户端：`packages/providers/src/openai-models-client.ts` 限时 15 秒、响应最多 2 MiB，不透传原始上游错误或网络异常内容。
- 纯目录解析与分类：`packages/providers/src/openai-model-catalog.ts` 校验最多 10000 项，去重并稳定排序，只返回 `id`、`created`、`ownedBy`、`shutdownDate`。
- 前端：目录读取状态与保存状态独立，凭据变更废弃旧目录，失败保留表单；原协议兼容入口继续独立配置。

官方 `/models` 没有返回端点、输入模态、JSON Schema 支持、图片尺寸或声音清单。名称分类只是用途提示，未知模型仍需确认与当前协议的兼容性。目录读取成功不会把连接状态改为生成已验证，也不会创建任务、费用预留或自动保存配置。此变更不需要数据库迁移。

## 验证

2026-11-08，在 Linux / Node.js 24.22.1 执行：

- `OWNTAKE_TEST_FONT=/tmp/owntake-fonts/NotoSansCJKsc-Regular.otf npm run check` 通过：三端类型检查、178 项自动化测试、生产 Web / 桌面服务构建、独立目录服务冒烟均通过。
- 新增 11 项模型发现测试验证严格元数据解析、去重排序、用途分组、固定官方 GET、跳转和非 2xx 拒绝、脱敏、2 MiB / 10000 项上限、读体超时与取消，以及真实 Fastify 会话 / CSRF。
- 读取已有或临时 Key 前后，SQLite `total_changes()` 与 vault 文件字节不变；原有 9 项统一连接测试仍通过。
- 浏览器通过 9 组场景：新默认值与预设、用途分组与未知型号、刷新保留选择和手填、失败回退、已保存 Key 与旧 5.4 手动切换到 6.1、新 Key 优先与迟到响应、关闭和切换连接、390 px 窄屏与兼容入口，以及无页面错误 / 外部请求。迟到响应的 mock 特意忽略 `AbortSignal`，独立验证请求序列守卫。
- 目视检查桌面下拉与 390 px 窄屏截图；修复分组搜索时已有型号重复显示为手填项的问题后，再次通过 `npm run typecheck`、`npm run build:desktop`、`npm run smoke:service` 与 `git diff --check`。

所有供应商测试使用受控目录响应与假 Key，不使用用户凭据，不调用真实模型。模型质量、账号实际返回内容和真实生成权限尚未实测；本地服务冒烟不等同于原生 Electron 或 macOS 安装包验收。

## 官方依据

- [当前模型目录](https://developers.openai.com/api/docs/models)
- [List models 字段](https://developers.openai.com/api/reference/resources/models/methods/list)
- [GPT-6 的端点与参数兼容性](https://developers.openai.com/api/docs/guides/latest-model)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT Image 2.6 参数与自定义尺寸](https://developers.openai.com/api/docs/guides/image-prompting)
