# OpenAI 统一连接

## 使用

在「设置 → OpenAI → 添加 OpenAI」填写一次官方 API Key 并保存。连接名称和三类模型已有默认值，可在高级设置中调整，并读取账号模型列表或手动填写 ID，见 [模型发现说明](openai-model-discovery.md)。分镜推理、抽样画面审核、图片候选与配音请求会分别出现对应的 OpenAI 目标，无需再填写三次密钥。

回到 OpenAI 卡片编辑时，Key 留空保留原值，填写新 Key 则统一更新三类能力。保存成功清空表单中的 Key；保存失败保留用户输入以便修正。保存只更新本地配置，界面不会将其显示为真实模型验证通过。

「协议兼容连接」继续用于第三方和本地兼容服务，可分别设置 Base URL、模型、密钥与能力。已有单协议连接不会自动合并、覆盖或丢失。OpenAI 官方入口固定使用 `https://api.openai.com/v1`，不会将它的共享 Key 发送给单独配置的其他来源。

## 默认模型与范围

默认值在 `packages/providers/src/openai-presets.ts` 集中维护，依据 2026-11-08 核对的官方文档预填；账户权限、额度和模型质量需在用户实际调用时确认。

| 能力 | 默认模型 | 当前协议与设置 |
| --- | --- | --- |
| 分镜 / 抽样画面审核 | `gpt-6.1-sol` | Chat Completions、严格 JSON Schema；总输出上限 8192 tokens（含推理 token）；审核最多 3 帧 |
| 图片 | `gpt-image-2.6-flare` | Images 文生图、PNG；16:9、9:16、1:1；不发送旧 `response_format` 字段 |
| 配音 | `gpt-4o-mini-tts` | Speech、WAV、官方声音列表、0.25–4 倍速、最多 4096 字符；支持独立语气指令 |

三个目标默认请求超时均为 120 秒。高级模型覆盖需满足相应接口与能力要求；保存不探测模型权限。图片适配器使用 1536×864、864×1536、1024×1024 三种尺寸，替换图片模型时需确认其支持这些尺寸。配音切到不属于 `gpt-4o-mini-tts` 系列的模型时，不自动宣称其支持风格指令，声音使用较保守的列表。

OpenAI 已公布 `tts-1`、`tts-1-hd` 与 `gpt-4o-mini-tts` 系列将在 **2027-01-06** 停服。替代模型使用 Realtime API，需要单独实现语音适配器，不能仅替换本页模型 ID。此次复用当前 Speech 流程，并在高级设置保留这一明确提示。

## 数据与更新语义

- schema 6 增加 `openai_connections` 和 `openai_connection_profiles`，启动旧库前沿用现有迁移快照机制。
- 一个 OpenAI 连接与三个稳定 profile ID 关联，原推理、生成和创作工具模块继续使用原类型的 profile。
- 新建或换 Key 只写入一个 vault 条目，三个 profile 引用同一版本；普通模型编辑不会新增 Key 副本。
- 更新携带 `expectedRevision`；版本冲突和非法字段在修改前拒绝，三个 profile 与连接元数据在同一个 SQLite 事务提交。
- 正在排队或已提交的调用保存原 profile 和凭据引用；统一换 Key 不改变其冻结目标，也不会重发任务。
- 受管理的 profile 经旧 `PUT /providers/:id` 修改会返回 `409 MANAGED_PROVIDER`，避免三项能力的密钥被分别改散。
- 公共响应和数据库 JSON 不含 Key；备份继续排除凭据文件。恢复后 OpenAI 连接和 profile 归属保留，重新填写一次 Key 即可配置未来调用。旧任务缺失的原凭据不会被新账号静默替换。

凭据文件与 SQLite 不属于同一个事务：如果新凭据写入后数据库提交失败，连接和三个 profile 会整体回滚，凭据文件可能保留一个未被引用的新版本。原配置和原凭据引用不受影响。

## HTTP 入口

所有入口位于原有会话与 CSRF 保护范围内：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/openai-connections` | 列出账号及其模型、profile ID、版本与是否有 Key |
| `POST /api/openai-connections` | 一次保存 `label`、`models`、`key` 并创建三类能力 |
| `PUT /api/openai-connections/:id` | 更新相同连接，附带 `expectedRevision`；Key 可留空保留 |

`GET /api/providers` 继续返回原有协议类型，新增可选 `connectionId` 标记统一管理的 profile。兼容连接面板隐藏这些派生项，各功能的模型选择框仍可使用它们。

## 验证

统一连接首次交付时（2026-11-08）在本地 Linux / Node.js 24.22.1 验证；后续模型发现和新默认值的记录见 [模型发现说明](openai-model-discovery.md)：

- `OWNTAKE_TEST_FONT=/tmp/owntake-fonts/NotoSansCJKsc-Regular.otf npm run check` 通过：三端类型检查、167 项测试、生产 Web 与桌面服务构建、独立目录服务冒烟均通过。
- 新增的 9 项 OpenAI 仓储与 HTTP 测试覆盖共享凭据、轮换、三种已提交任务快照、版本冲突、SQL 中途失败回滚、重启、备份恢复、schema 5 升级、会话 / CSRF 和兼容连接。
- 旧库 fixture 按外键顺序删除新增表后，保留原精确表集合断言；schema 1 / 2 升级验证通过，并检查新表实际创建。
- 前端最后补充列表请求顺序保护与兼容表单保存回执后，重新通过 `npm run typecheck`、`npm run build:desktop` 和 `npm run smoke:service`。
- 独立临时数据目录、Chromium 153 与测试 Key 的 14 项浏览器检查通过：一次填写、模型覆盖、留空保留 Key、错误后保留输入、轮换后清空、刷新持久化、原兼容 / CLI 入口、三个能力选择框、390 px 窄屏，以及两种延迟列表响应场景。桌面与窄屏已目视检查；没有页面异常、外部浏览器请求或收费任务提交。

测试使用独立临时数据库和测试密钥，不调用真实 OpenAI，不将本地配置保存成功称为真实供应商验收。本地服务 bundle 冒烟不等同于原生 Electron 或 macOS 安装包验收；原生验收由仓库的 Linux / macOS CI 另行执行。

## 官方依据

- [API 身份认证](https://developers.openai.com/api/reference/overview)
- [GPT-6.1 Sol 模型与结构化输出能力](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT Image 2.6 参数与尺寸](https://developers.openai.com/api/docs/guides/image-prompting)
- [Images 请求字段与尺寸](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Speech 模型、声音与格式](https://developers.openai.com/api/docs/guides/text-to-speech)
- [官方弃用计划](https://developers.openai.com/api/docs/deprecations)
