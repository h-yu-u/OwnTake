# 开发与验证

## 准备

使用 Node.js 24.12+ 的 24.x、npm、FFmpeg/ffprobe。字幕导出需要 libass 和覆盖目标字符的字体。macOS 可用 Homebrew 的 ffmpeg-full；Windows/Linux 使用受信任的软件来源。先安装系统工具，再设置并检查 Node，避免包管理器改变 PATH。

```sh
node --version
node -p "process.platform + '/' + process.arch"
ffmpeg -version
ffprobe -version
npm ci
npm run dev
```

开发前端默认 `http://127.0.0.1:5173`，通过开发代理访问本地核心。生产 Web：`npm run build && npm start`，默认 `http://127.0.0.1:4317`。桌面：`npm run desktop`。无需 Docker、云数据库或外部队列。

## 验证层级

| 命令 | 能证明什么 | 不能代替什么 |
| --- | --- | --- |
| `npm run check:docs` | 维护文档的本地链接/目录合同 | 文档语义和真实功能验收 |
| `npm run test:tooling` | 命名、签名配置、架构识别、清单聚合等纯工具规则 | 实际原生安装包运行 |
| `npm run typecheck` | 服务端、Vue、桌面的类型约束 | 行为正确性 |
| `npm test` | 领域、存储、API、媒体、恢复的自动回归 | 真实收费供应商质量 |
| `npm run check` | 上述检查、生产构建、独立服务 bundle smoke | GUI 安装/签名验收 |
| `npm run smoke:desktop` | 源码构建的真实 Electron 流程 | 分发包无缺失依赖 |
| `npm run package:desktop` + `npm run smoke:package` | 本机构建并验证解包后的应用 | 安装器 GUI 全流程/可信签名 |

测试使用隔离临时目录；不要把真实作品目录设置成测试目录。`OWNTAKE_TEST_FONT` 可显式指定中文测试字体，`OWNTAKE_LOG_LEVEL=silent` 用于控制回归日志。普通测试不发起真实收费模型调用。

## 原生打包

当前机器的 OS 和 CPU 架构必须匹配目标，不用另一架构模拟构建假装原生验收：

```sh
npm run package:desktop
npm run smoke:package
```

也可显式指定 `--target darwin-arm64` 等已登记目标。`package:mac`、`package:windows`、`package:linux` 是同一入口的本机别名。打包要求受版本控制的修改已经提交；不要把临时编辑与源码提交混成不明版本。

Linux 无显示环境使用 `xvfb-run --auto-servernum npm run smoke:package`。受隔离 CI 环境需要的测试 sandbox 例外必须显式设置，不改变应用生产默认。完整矩阵与签名见[发布说明](../operations/release.md)。

## 文档与 PR

先读 [AGENTS](../../AGENTS.md) 和[代码规范](../code-standards.md)，只修改本次范围内的行为。更新对应子系统说明，在 PR 中写清实际执行的命令、平台、结果和未测边界。历史通过记录不能替代对最终 HEAD 的验证。
