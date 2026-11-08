# 存储、资产与备份

## 责任与入口

[Store](../../packages/storage/src/store.ts) 拥有 SQLite 连接、同步嵌套事务、项目和资产登记；[schema](../../packages/storage/src/schema.ts) 按顺序升级数据库。媒体大文件保存在项目目录，元数据引用确定的资产 ID、相对路径、大小与 SHA-256。

## 关键不变量

已登记的 Artifact 不允许原地改写；新内容是新资产。项目、时间线和镜头引用必须属于正确项目。读取从资源 ID 解析真实路径，拒绝目录逃逸、符号链接逃逸和不匹配的文件；恢复原素材必须匹配原摘要，不能把替换文件当作恢复。

`Store.transaction` 中只能执行同步工作；跨网络/文件/媒体处理先在事务外完成，再短事务发布结果。数据库状态、任务状态和事件在需要时一起提交，防止仅一部分成功。更新使用期望版本；不能靠读后直接写覆盖并发编辑。

## 升级与备份

[迁移前快照](../../packages/storage/src/migration-backup.ts) 是数据库元数据快照，明确不等于含视频文件的完整备份。高于当前应用的数据库版本应拒绝写入。

[完整备份](../../packages/storage/src/backup.ts) 生成一致 SQLite 快照并收集引用媒体，校验摘要，包含已完整接收但尚未完成登记的受支持结果。恢复只允许空目标目录，先验证版本、清单、路径、大小与摘要，不混入已有项目。密钥不随项目备份。

目录默认值和移动操作见[配置与备份](../operations/data-and-configuration.md)。升级不得悄悄把 Windows/Linux 用户数据迁移到新的默认位置。

## 验证

使用临时 SQLite 和真实小文件检查嵌套回滚、冲突、路径越界、损坏素材、恢复到非空目录、旧 Schema 升级和迁移失败。基准：[storage tests](../../tests/storage.test.ts)、[migration tests](../../tests/migration-backup.test.ts)。新表的备份责任必须在同一 PR 明确。
