# Fastify 迁移：分层、兼容性与验证

本次迁移基于包含 P5 桌面实现的 `main`，将手写 Node HTTP 分发整体替换为 Fastify 5。项目、分镜、Provider、生成、Studio、健康与设置、上传、媒体读取、缩略图、SSE、静态网页全部接入同一应用工厂。原有路由分发、JSON 读取、会话签名、Range 与 SSE 协议实现已移除。

## 模块职责

| 层 | 位置 | 职责与依赖 |
| --- | --- | --- |
| 装配入口 | `apps/server/src/app.ts` | 连接配置、核心资源与 Fastify 插件，提供 `buildApp` / `startServer` |
| 生命周期 | `bootstrap/core.ts` | 数据目录互斥、Store 与 Runner 创建、启动、停止、最终释放 |
| HTTP | `http/routes/`、`http/plugins/`、`http/schemas/` | 声明式路由、TypeBox 请求校验、鉴权、错误协议、响应与流 |
| 应用用例 | `application/` | 时间线、导出、上传、分镜转换等多步骤操作及事务边界；无 Fastify 依赖 |
| 业务与执行 | Repository、Runner、`packages/domain` 等 | 原有状态机、版本、预算、去重、不可变资产及恢复规则 |
| 配置 | `config/` | 启动配置与独立的 HTTP、会话、媒体、事件流、时间线策略 |

路由使用 TypeBox 类型推断，不重复声明请求 DTO。传入的应用上下文以 `Pick<ApplicationContext, ...>` 限定实际需要的资源。简单查询可直接委托 Repository；涉及等待、校验、事务或多个资源的操作进入应用用例。没有为每个读取操作额外建立一层转发类。

新增接口时，在对应 `http/schemas/` 模块定义输入形状，在业务路由模块注册处理函数；复合行为放在应用用例中，并返回或等待其 Promise，供关闭流程等待完成。所有 API 模块注册在受保护的 `/api` 作用域，继承会话、CSRF、缓存和错误处理。不要另起服务器或在新端点内复制认证逻辑。

## 复用的框架能力

| 能力 | 实现 |
| --- | --- |
| 路由、生命周期、请求 ID、请求日志、JSON 解析与限额 | Fastify |
| 请求 Schema 与类型推断 | TypeBox + `@fastify/type-provider-typebox` |
| 安全响应头 | `@fastify/helmet`，保留本地应用 CSP |
| 签名 Cookie 与会话 | `@fastify/cookie` + `@fastify/session`；官方 MemoryStore 配有界 LRU 与 TTL |
| 写入验证 | `@fastify/csrf-protection`，Token 只从请求头读取 |
| 静态网页、媒体 Range / HEAD / 缓存语义 | `@fastify/static` |
| SSE 编码、心跳与流写入 | `@fastify/sse`；应用只负责持久事件游标与断连清理 |

Host / Origin / Fetch Metadata 的本地来源规则、注册资产的路径边界与领域错误码仍由 OwnTake 定义。框架处理通用 HTTP 行为，项目保留自身业务约束。

会话限定 12 小时、最多 100 个，Cookie 为 HttpOnly / SameSite Strict；服务重启会更换签名密钥，使旧会话失效。刷新会话端点不会使同一浏览器旧标签页中的 CSRF Token 失效。所有写入 API，包括原始上传，在读取正文前验证会话与 CSRF。

## 兼容性与明确变化

既有 URL、正常响应状态码和响应字段保持兼容。JSON 路由使用 Schema 进行输入验证，不对输出添加会删减已有字段的序列化 Schema。原有领域校验仍执行，版本冲突、预算与幂等判定未移到 HTTP 层。

- JSON 正文默认上限 1 MiB；类型不自动转换，不把数字字符串当数字，也不静默删除应被拒绝的字段。已有 nullish 默认值与允许忽略的额外字段按原合同保留。
- 不支持的 Content-Type 明确返回 415，损坏 JSON 返回 400，过大请求返回 413；错误继续采用 `{ error: { code, message, details? } }`。
- 结构校验发生在应用查询之前。如果同一请求同时具有非法字段与不存在的资源，首先返回的错误可能与旧分发顺序不同。
- 未知 `/api` 路径仍执行认证并返回 JSON 错误；不会落入网页的 SPA fallback。
- 上传继续采用已有 `application/octet-stream` 协议，默认上限 256 MiB。文件流通过有界管线写入临时文件，检查实际字节数、媒体、摘要和路径后才发布资产。未改成 multipart，也不把大文件整体读入内存。
- 媒体端点只接受已登记的资源 ID，验证实际路径之后调用静态插件发送文件；项目目录不作为公共静态目录挂载。网页目录同样拒绝符号链接逃逸。
- SSE 沿用 `Last-Event-ID` / `after` 游标、持久事件与 `change` 事件名；关闭浏览器连接不取消后台任务。
- 请求日志仅记录请求 ID、方法、路由模板、响应状态与耗时；不写入正文、认证头、原始 URL / 查询串或供应商错误正文。

## 启动与关闭

`buildApp(overrides)` 创建 Fastify 实例并取得数据目录所有权，可通过 `inject()` 测试；不开放端口，不执行持久任务。生产入口 `startServer(overrides)` 在监听成功后启动各 Runner，Web 与 Electron 共用。

关闭流程停止 Runner、结束 SSE、取消上传并等待临时文件清理。连接关闭不代表异步用例已经结束：HTTP 生命周期插件跟踪处理函数返回的 Promise，在最终释放 Store 之前等待全部完成，同时保持框架同步 / callback 处理函数的返回语义和 `this` 绑定。

Store 与实例锁有明确所有者，关闭幂等；端口冲突、插件加载失败或某个 Runner 停止异常不会遗留目录锁。Fastify 实例本身是 thenable，因此 `buildApp()` 也显式捕获返回实例时的插件启动异常并释放资源。关闭阶段如有失败，在资源释放后向调用方报告。数据、项目和网页目录覆盖值统一归一化为绝对路径。

## Electron 打包

桌面继续分发独立 ESM bundle，不包含 `node_modules`。Fastify 的 CommonJS 依赖使用构建时注入的 `createRequire` 加载 Node 内置模块。Cookie 会话方案不引入额外本机加密二进制。

`npm run smoke:service` 将生产 `service.mjs` 和网页产物复制到独立临时目录，用 Node IPC 模拟 Electron 父端口并启动真实服务；检查静态资源、会话、CSRF、健康、项目创建和正常关闭。此检查专门发现打包后缺失依赖或模块格式不兼容，已加入 `npm run check`。它不替代真实 Electron 窗口、沙盒和原生桥接检查。

## 验证记录

本地环境为 Linux / Node 24.22.1，已在最终迁移代码上执行 `npm run check`，退出码 0：

| 检查 | 结果 |
| --- | --- |
| 服务端、Vue、桌面 TypeScript | 全部通过 |
| Node 测试 | 155 / 155 通过，无跳过；原有 135 项加本次新增 20 项 |
| Vue 生产构建与桌面三个入口 bundle | 通过 |
| 独立临时目录内运行生产服务 bundle | 静态资源、认证、写入、健康、退出及锁释放全部通过 |
| `git diff --check` | 通过 |
| 本地原生 Electron 冒烟 | 已尝试；容器拒绝单实例功能所需的 AF_UNIX socket，应用启动在系统权限边界中止，未视为通过 |

新增测试分别覆盖 8 项 HTTP 合同、7 项资源生命周期及 5 项媒体 / SSE 风险，包括插件启动失败、强制断连后等待异步写入、关闭异常、上传中断和工作目录清理。中文媒体验收使用与现有 macOS CI 相同固定提交、通过 SHA256 核验的 Noto Sans CJK SC 字体。可通过 `OWNTAKE_TEST_FONT` 指定字体路径，`OWNTAKE_LOG_LEVEL=silent` 关闭测试请求日志。

生产构建仍提示前端主 chunk 超过 500 kB；这是既有前端构建体积提示，不影响本次构建通过。原有媒体与供应商测试使用合成文件和本地故障夹具，没有调用真实收费模型；本地 Linux 结果不视为 macOS 验收。

CI 继续执行 Linux / macOS 的 `npm run check`、真实 Electron 冒烟，以及 macOS ZIP 打包后的应用冒烟。P5 的外部账号、用户字体、休眠唤醒与目标机器边界仍见 [P5 验证记录](p5.md)。
