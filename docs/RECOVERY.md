# 会话恢复、幂等与未知结果

## 状态与 fencing

```text
PENDING → RUNNING → PREPARED → SENDING → SENT
PENDING / PREPARED → CANCELLED
RUNNING / SENDING → QUARANTINED
SENDING → FAILED（只有明确未送达）
```

每次读/写 worker 状态在事务内检查 lease owner、epoch、expiresAt。owner 表示持有者，epoch 递增隔离旧代，expiry 限制租约时间。acquire 只允许一个未过期持有者；renew 可用，当前 worker 不自动续租。lease 预算为两段调用 deadline 外加余量，不能把它当成对 authorize/store 延迟的硬保证；延迟导致失租时旧提交被拒绝。

隔离 turn 挡住同 session 的后续上下文；其他 session 不受其状态阻挡。SENT、FAILED、CANCELLED 为终态，保留记录去重；不提供自动清隔离、force resend 或删 tombstone 的 API。

## 故障矩阵

| 边界 | 再次执行 | 证据 |
| --- | --- | --- |
| 入队后撤权，仍 PENDING | CANCELLED；不调用 provider | LOCAL UNIT / loopback |
| provider 返回后撤权 | 已提交 PREPARED 记忆，CANCELLED；不发送 | LOCAL UNIT |
| RUNNING 中断 / provider 异常 | QUARANTINED，不重跑 | crash hook / LOCAL UNIT |
| PREPARED 已保存 | 重用 reply，不重跑 provider | LOCAL PROCESS 新 Node |
| SENDING 中断（包括调用前） | QUARANTINED，不盲目重发 | crash hook / LOCAL UNIT |
| send 后未记录 | QUARANTINED，可能已经送达 | crash hook / LOCAL UNIT |
| SENT 已保存 | IDLE，不重发 | LOCAL PROCESS 新 Node |
| provider/sender 超时 | signal abort，隔离；迟到效果仍可能发生 | LOCAL UNIT，忽略 abort fixture |
| checkpoint 总容量超限 | 原子拒绝 reply/Markdown/revision 更新，隔离、不发送 | LOCAL UNIT |
| 快照损坏、scope 不匹配、非法 revision | load 拒绝 | LOCAL UNIT |

超时只结束等待。AbortSignal 是协作请求，不能证明未运行或未送达；Promise race 不杀死底层代码。provider 异常同样可能发生在工具效果之后，因此原 demo 的“失败自动重试”已改为隔离断言，故障仍被覆盖。存储失败或失租也不能重新声明外部调用没发生：记录可能仍为 RUNNING/SENDING，下次 worker 隔离。

fencing 保护存储；远端 sender 不理解本地 epoch，本核心不承诺 exactly-once 外部送达。发送前的当前授权只能阻止尚未开始的发送。

## 检查点与容量

PREPARED 事务将 reply 与当前 scope 的 Markdown 共享递增 revision。恢复此状态时无需 provider；恢复 SENT 不重复 sender。后续 revision 会更新 session memory，历史 turn 保留其 reply/revision，不保存每个历史 Markdown 副本。CANCELLED 若发生在 PREPARED 后不会回滚已提交记忆。

每 session 最多 100 turns。所有 ledger mutation 的序列化 JSON UTF-8 硬上限为 850000 bytes；admission 和 PREPARED 使用 848976 bytes，余下 1024 bytes 留给 lease/status/reason 管理。owner 最多 64 code units，reason 最多 120；回复和 Markdown 另有单项限额。检查使用应用 JSON 字节，不能据此宣称真实数据库编码配额已验收。

测试分别构造 Unicode admission 增长、reply 增长、Markdown 增长；超限不覆盖之前 memory/revision，不发信。重复已存在 turn 仍能去重，容量不自动删除终态记录。恢复/import 的状态是可信管理输入，文件 load 校验其容量和检查点字段；不是不可信任意状态导入服务。本批不增加归档模块。

## 本地文件快照

FileSnapshots 保存 `{schemaVersion, sessionKey, state}` 的 payload 和 SHA-256 envelope，文件上限 1 MiB（包括 envelope 的 JSON 转义）。流程是临时文件独占创建、写入、file fsync、关闭、rename、directory fsync。失败拒绝成功回执；rename 后目录 sync 失败可能目标已更新，不能据异常推导“没有写过”。临时写失败会清理本次临时文件。

恢复先检查大小、摘要、schema、scope、revision、状态及单项容量，再清理旧 lease。此清理只适用于确认旧 writer 已停止的本地恢复；不能在活跃系统里用 load 抢 lease。目录必须由可信操作方控制，不构成敌对 symlink 沙箱。SHA-256 检测损坏，不认证有权限重算摘要的写者。

当前 schemaVersion/version 仍为 1，新增 revision 为必需字段；不提供旧快照自动迁移。上线前须明确兼容策略。save 是显式工具，不是自动持久事务，不保证易失 demo 的实时备份。

`node --test test/recovery.test.mjs` 会真正写文件并启动新的 Node 进程，在子进程中恢复 PREPARED/SENT、执行 worker、核对 memory 与 record revision 和调用次数。结果只有脱敏摘要。其他 crash 点是异常注入，不是 OS kill；未验收云重启、跨实例存储、Hermes SQLite 一致备份或真实外发。
