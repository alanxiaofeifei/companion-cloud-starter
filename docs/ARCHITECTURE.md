# 架构与信任边界

## 当前数据流

```text
loopback HTTP（先方法/路径/secret，再有界 body）
  → createIngress / route（平台字段 + 服务端 policy）
  → MemoryInbox.createOnce（同 ID 冲突检测）
  → 本地 queue.enqueue（读权威 inbox，ledger.admit，登记 session）
  → processSession（当前授权 + fenced lease）
  → synthetic runTurn → PREPARED 检查点 → 再授权 → local sender → SENT
```

`demo-server.mjs` 是传输，`demo.mjs` 只组合端口。唯一业务 worker 是 `worker.mjs`。默认 `server.mjs` 保留 smoke 行为，`cloud-run.example.yaml` 仍是占位，不会运行 demo 或真实业务。

## 权限来源与 scope

webhook secret 认证入口通道；不自行授予成员权限。只有平台字段 `from.id/chat.id/chat.type/message_thread_id` 和服务端 allowlist 参与路由。昵称、正文的“我是管理员”、模型输出及正文 JSON 不赋予权限。真实平台来源认证尚未接线，合成 demo 的固定 secret 只用于离线 fixture。

私聊要求 sender = chat 且在 privateUsers；群要求指定负数 chat 与指定 member 联合允许；机器人、匿名 sender_chat、频道和不支持的消息形状拒绝。群成员共享同群同 topic 的上下文，不读取成员 private scope。sessionKey 覆盖 tenant/chat type/chat/topic，turnId 覆盖 tenant/update ID。tenant 是独立 bot 的 update ID 命名空间，不应由多个 bot 混用。哈希是索引，不是匿名化或授权；ledger 内容仍可能包含运行数据。

admission 时 `route` 校验，执行前与发送前 `currentlyAuthorized` 读取当前 policy。撤权不撤销已经发出的调用；fencing 也只能阻止旧 worker 写状态，不能撤回远端副作用。scope 检查不构成工具的文件/网络沙箱。本轮没有工具端口。

## 原子性、检查点和耐久

`transact(key, pureCallback)` 一次操作一个 session。callback 可能重跑，不能发信、调用 provider、入队或上传。`MemoryState` 本地串行；`FirestoreState` 映射官方客户端事务，只有 fake 验收。

provider 输入为冻结的 turn/principal、该 scope 的 memoryMarkdown、协作 signal 和绝对 deadline，输出 `{text, memoryMarkdown}`。text 最多 4096 JS code units，Markdown 最多 65536 UTF-8 bytes。回复、session Markdown 和递增 revision 一起提交，record 带该 revision。sender 返回 `sent/definite_fail/ambiguous`；只有明确定义为“未送达”的 definite_fail 可终止为 FAILED，异常属于未知。

在易失 MemoryState 中，PREPARED 只表示内存提交。真实耐久需持久端口承诺；provider 自报 durable 被忽略。FileSnapshots 显式保存同一 ledger/Markdown，不能被当成自动逐 transition 持久层。

## 队列边界：设计契约，未实现调度器

inbox ID 是接入事件身份，turnId 是逻辑执行身份，dispatch intent 是需要唤醒的持久意图，queue task ID 是某次派发身份。前两项已实现，后两项仅有协议说明。入队 exists 只说明某个任务名存在，不能证明业务完成；业务必须以 ledger SENT 等终态为准。

现有 ingress 先 createOnce 再 enqueue：入队异常返回 503，重复请求用同一 ID 再入队修复。没有持久 dispatch intent、有界 reconciler 或完成保证。demo queue 是内存唤醒集合，不能代表真实 durable queue。建议的崩溃轨迹与预算见中文笔记。

## 快照与未来云边界

FileSnapshots 是单个可信 writer 的本地 fsync/rename/checksum 快照；恢复必须停止旧 writer。GcsSnapshots fake 展示指定 generation 读取、metadata size 和摘要校验、create-only 上传。对象名定位、generation 精确版本、size/digest 检查内容、manifest 描述一致 revision/scope、pointer 选择已提交 manifest，各自不能替代其他职责。

upload 目前只返回 digest，缺少可信 upload generation 和 pointer CAS；不提供恢复 manifest store。DocDb、outbox/reconciler、完整 uploader、真实 IAM/OIDC/queue/provider/Telegram 均未实现。Hermes 占位不证明其 SQLite、Markdown、工具、后台工作或 OAuth 已接通。
