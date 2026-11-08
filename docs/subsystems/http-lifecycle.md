# HTTP 与生命周期

## 责任与入口

[app.ts](../../apps/server/src/app.ts) 装配 Fastify，[core.ts](../../apps/server/src/bootstrap/core.ts) 唯一持有 Store、Runner、缩略图服务和数据目录锁。`buildApp()` 用于可注入的 HTTP 测试；`startServer()` 才监听并启动恢复/后台执行。Web 与桌面共用这套入口。

## 请求合同

路由在受保护的 `/api` 作用域内注册，TypeBox 描述输入，领域逻辑验证资源归属和状态。错误保持统一 JSON 合同。未知 API 不能回退成 SPA HTML；JSON 不静默转换类型或移除应拒绝的字段。安全机制包含精确 Host/Origin、会话、CSRF 和安全响应头，不开放公网或通配 CORS。

普通 JSON 与媒体上传是不同解析路径。上传使用有界原始流，而非把所有文件拼成一个 JSON 正文。静态网页和已登记媒体的 Range/HEAD 由框架插件负责，项目数据目录不作为公开静态目录。

## 关闭与失败

[handler tracking](../../apps/server/src/http/plugins/lifecycle.ts) 区分“连接关闭”与“处理函数结束”。先停止后台调度/工作，取消并等待上传，结束 SSE，随后排空应用处理函数，最后关闭数据库、释放实例锁。重复关闭幂等；插件失败、端口占用或部分资源失败也必须释放已获得资源。

SSE 传输断开不取消已持久化任务；客户端恢复使用事件游标。新增长连接必须加入统一关闭所有权，不能自行持有永远不结束的 Promise。

## 变更与验证

新增接口注册到现有路由作用域；复合操作进入 application，不把 Fastify request/reply 传入领域。修改认证、上传或关闭需覆盖无会话、缺失 CSRF、错误类型、断连、慢请求、启动失败和重复关闭。历史迁移理由见 [Fastify 记录](../validation/fastify.md)，该记录不是最新测试结果。
