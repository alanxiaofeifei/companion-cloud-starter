# Companion Cloud Starter

一个标准库实现的实验性参考核心：可信接入、scope 隔离、fenced 会话 ledger、回复与 Markdown 检查点、幂等终态和未知结果隔离。可离线运行合成 HTTP 示例；不是已接通的云端助手。

| 模式 | 实际行为 |
| --- | --- |
| 默认 smoke | `npm start`；健康检查 200，所有业务请求 503 |
| synthetic loopback | `npm run demo`；可信 ingress → 内存 inbox/queue → SessionLedger/processSession → 合成 provider → 本地数组 |
| 真实集成 | 未实现/未验收：真实模型、Telegram、IAM、queue、OAuth、Secret Manager、云持久化、Hermes |

## 五分钟离线运行

需要 Node 22 或更新版本，不安装依赖、不需要真实 token。本地验证使用 Node 24.19.0；代码提交 `67d18a2b0b577970a1cc9d07ea404157f66e01d0` 已通过 [Node 22/24 的 CI 验证](https://github.com/alanxiaofeifei/companion-cloud-starter/actions/runs/38040415468)。

```sh
npm test
npm run check
npm run demo
```

在另一终端只访问本机：

```sh
curl -s http://127.0.0.1:8081/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: synthetic-webhook-secret-for-testing' \
  -d '{"update_id":1,"message":{"message_id":1,"chat":{"id":101,"type":"private"},"from":{"id":101,"is_bot":false},"text":"Hello"}}'
```

响应含 `accepted:true`、`duplicate:false` 和 `responses`，其中合成回复为 `Synthetic reply: Hello`。重复相同请求得到 `duplicate:true`；数组仍只有一条送达。同 ID 改正文返回 409。`responses` 是进程内累计的合成数组，不是 Telegram 送达凭证；`accepted` 只表示 admission/enqueue 成功。撤权或隔离可能已接收但没有回复。

demo 仅监听 `127.0.0.1`，无模型或工具调用，sender 只写数组。它使用恢复测试中的同一套 worker，不另设简化重试语义。状态在退出时丢失；文件快照是显式调用的独立单写者工具，不自动为 demo 持久化。

```sh
node --test test/http.test.mjs
node --test test/recovery.test.mjs
node --test test/privacy.test.mjs test/release.test.mjs
```

恢复测试展示 PREPARED 新 Node 进程恢复不重跑 provider、SENT 新进程恢复不重发、RUNNING/SENDING 中断与忽略 abort 的超时隔离，以及容量、scope、快照损坏。异常 crash hook 与新进程恢复分别报告，不冒充 OS kill 或云重启。

## 实际契约与边界

`runTurn(turn, {signal, deadlineMs, memoryMarkdown})` 返回 `{text, memoryMarkdown}`。provider 提议回复和记忆；ledger 在同一 revision 原子提交后进入 PREPARED。provider 的 `durable:true` 没有任何证明力。`MemoryState` 只保证进程内原子性；耐久承诺必须来自真实持久事务适配器的提交。

HTTP 在 body 读取前校验方法/路径/secret，流式上限 64 KiB，处理坏 JSON、超限、中止和 body deadline。ledger 最多保留 100 turns；JSON UTF-8 硬上限 850000 bytes，admission/检查点预算 848976 bytes，预留状态管理空间。拒绝增长，不删除去重记录，也没有归档系统。

Firestore/GCS 是注入式端口，现有测试只使用 SDK fake，未安装真实 SDK。GCS create 只返回摘要，尚不能建立可信恢复 pointer。`HermesRuntime` 始终明确抛出未实现错误；没有分发其代码、schema、fixture 或指导文本。

阅读 [架构](docs/ARCHITECTURE.md)、[恢复](docs/RECOVERY.md)、[运维](docs/RUNBOOK.md)、[工程取舍](docs/LESSONS.md) 和 [详细中文工程笔记](docs/ENGINEERING_NOTES.zh-CN.md)。一般云角色、六项已核对官方行为及剩余待核验项见运维文档；真实云/SDK/IAM 运行验收仍为 NOT RUN。

## 来源与许可

这是 [公开实验参考仓库](https://github.com/alanxiaofeifei/companion-cloud-starter) 的小型原创实现。公开例子全部合成，不包含私人历史、身份资料、真实云配置或运行记录。保留 [LICENSE](LICENSE) 与 [NOTICE](NOTICE) 的公开维护者合法归属，MIT 许可；没有新增上游材料或官方集成背书。
