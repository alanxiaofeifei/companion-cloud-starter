# 从实验模板到合成参考核心：工程笔记

## 1. 范围、约束和可复现入口

**问题。** 一个健康检查和一条文字回复，容易让读者误以为接入、权限、持久化、模型和真实送达都完成了。小型模板还可能同时维护“简单 demo worker”和“恢复 worker”，形成相互矛盾的失败承诺。

**约束与决策。** 保持标准库、小文件和现有端口；不新建框架。默认 smoke 继续拒绝业务请求；loopback demo 使用现有 SessionLedger/processSession，合成 provider 无模型/工具，sender 只写数组。真实云、Telegram 和 Hermes 是未实现/未验收的独立层。demo 接收成功只是 admission，不承诺回复已经送达。

**合成例子。** README 的固定 update 1 返回 `Synthetic reply: Hello`。重复输入只保留一次本地送达；同 ID 换成另一正文返回 409。恢复测试显式保存 PREPARED，在新 Node 进程里发送该 reply，provider 调用数为零；另一个测试让 provider 等待超时，再提交同会话下一条消息，下一条保持 PENDING。

**验收与限制。** `npm run check` 无依赖安装、离线运行全部测试和 src/test 语法检查。本地验证使用 Node 24.19.0；代码提交 `67d18a2b0b577970a1cc9d07ea404157f66e01d0` 已通过 [Node 22/24 的 CI 验证](https://github.com/alanxiaofeifei/companion-cloud-starter/actions/runs/38040415468)。OS kill、云重启未运行。demo 状态易失，FileSnapshots 不自动接到每次 transition。测试细节可从 `test/http.test.mjs` 与 `test/recovery.test.mjs` 重现。

## 2. 公开核心的来源与数据边界

**问题。** 公开工程需要可复现的协议和证据，但不能把个人身份、记忆、账户、聊天或操作流水当成“真实案例”。换名字仍可能保留可识别关系、时间与云资源。

**决策。** 从既有公开基线继续，只改当前核心和公开文档。例子从零生成，许可以实际分发内容为准。保留原 LICENSE/NOTICE 的公开维护者合法归属；本批没有复制第三方实现、schema、fixture 或指导文本。Hermes 名称只用于明确失败的占位端口，不声称 native bridge 或官方背书。

**验收。** 文件清单、diff、示例 URL/路径/身份、配置和 symlink 分开审阅。privacy 测试生成虚构正文/secret canary，覆盖成功、拒绝、撤权、provider 异常、超时、restore failure，检查 stdout/stderr 和快照文件名。当前业务代码无正文日志；测试输出只报告场景摘要。公开 sender 数组可以展示公开的合成回复，这不允许真实部署记录原始内容。

**限制。** canary 只能证明这些路径没有输出这些值，不能推导未来 logger、安全 SDK 或全部运行环境已通过隐私验收。未来增加日志应采用字段白名单，只保留状态/计数/无个人语义 trace；trace 和哈希都不是匿名化保证。

## 3. 可信接入与 private/group/topic 权限

**问题。** webhook secret 只能证明请求持有通道凭据，不能证明正文里自称的角色。排队后 policy 可能改变，因此 admission 的允许不是永久许可证。

**决策。** HTTP gate 在读取 body 前校验方法、路径和 secret；再做流式 64 KiB 上限、JSON 与平台字段校验。private 要求 sender/chat 一致并在 allowlist；group 要求 chat 与 member 联合授权。topic 是会话 scope，不额外创建模型角色。worker 在执行和发送前再次读取当前 policy；模型不能修改 frozen principal。

| 合成输入 | 预期 |
| --- | --- |
| private：sender 101 / chat 101，policy 允许 101 | 接收 |
| private：sender 101 / chat 102，即使正文声称管理员 | 拒绝 |
| group：chat -201 / sender 101，二者匹配 allowlist | 接收 |
| group：chat -201 / sender 999 | 拒绝 |
| 同群 topic 1 与 topic 2 | 不同 sessionKey / 各自 Markdown |
| 匿名 sender_chat 或机器人来源 | 拒绝 |

tenant/chat type/chat/topic 的哈希键防索引冲突；tenant 应对应独立 bot 的 update ID 空间。群 topic 上下文为群内共享，成员私聊键与群键不同，不能因同一 user 自动合并。撤权在 admission 前导致 `accepted:false`；入队后撤权导致 CANCELLED，不运行 provider；provider 返回后撤权会保留已提交检查点，但不启动发送。

**验收与限制。** core 测试覆盖这些路由、攻击者 role/names、租户与 topic 隔离，demo 测试覆盖两次当前授权。HTTP gate 拒绝未完成的大 body，不解析其 JSON。真实 Telegram 来源、OIDC 以及工具网络/文件沙箱均未接线；prompt 隔离不是系统权限隔离。发送调用已经开始后不能承诺撤回。

## 4. 接收、派发和队列存在的含义

**问题。** “任务已存在”是队列命名事实，不是业务完成事实。把数据库写入、enqueue 和发送当成一个动作，会隐藏故障窗口。

**已实现决策。** createOnce 原子保留首个 inbox 内容，比较为结构比较而非 JSON 字段顺序。确定 turnId 属于 tenant/update，重复内容可以同 ID 重入队；内容冲突 409，不覆盖。存储/queue 异常返回 503；200 `accepted:false` 表示不支持或未授权，200 `accepted:true` 表示完成当前 admission/enqueue。demo 使用本地集合唤醒 ledger，无持久调度保证。

**官方事实短注。** 创建任务、ALREADY_EXISTS 或任务消失都不证明业务成功；ALREADY_EXISTS 可来自近期已执行/删除记录，任务名去重不保证 exactly-once 外部副作用。HTTP 2xx 是队列成功确认，提前确认后的后台失败不能被假定会触发重试。来源：[tasks.create](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create)、[重复执行](https://docs.cloud.google.com/tasks/docs/common-pitfalls)、[确认语义](https://docs.cloud.google.com/tasks/docs/dual-overview)。这是文档查证，真实 queue 运行验收仍为 NOT RUN。

**目标协议，未实现。** inbox ID 记录事件，turnId 记录逻辑执行，dispatch intent 记录持久唤醒需求，task ID 记录派发尝试。事务 callback 可能重试，只写 intent/state，不执行 enqueue 或其他副作用。建议先提交 inbox + intent，再事务外派发；dispatcher 的进度也需要持久记录。

| 纯合成故障轨迹 | 目标处理，当前未接通 |
| --- | --- |
| accept 提交后，enqueue 前崩溃 | 下一次调用扫描未派发 intent |
| enqueue 成功，标记派发前崩溃 | 可重试确认 task，仍检查 ledger 进度 |
| task exists，但 ledger 一直 PENDING | exists 不清除业务需求；确认安全后创建新 wake |
| 某一前缀连续失败 | 花费预算后推进 cursor，下一轮公平访问其他前缀 |

有界 reconcile 应明确每轮记录数、queue 调用次数和时间预算；cursor 持久提交，失败不无限吞掉预算。扫描条件、触发入口和公平性需要验收；没有入口调用就没有自发进展。新 wake 不能绕过 ledger quarantine/terminal dedup。本批只写此故障轨迹，不实现 outbox、reconciler 或完整 DocDb。现有 queue failure retry 测试证明有限路径修复，不证明最终交付。

## 5. 会话序列化、fencing 与未知效果

**问题。** 并发 worker、lease 过期和滚动版本重叠，会让旧进程继续拿着结果写回。另一方面，timeout 的远端操作可能晚些时候完成，错误不能直接等价为“未执行”。

**决策。** acquire 生成 owner/epoch/expiry，事务内每次 fencing；epoch 单调递增，旧 owner 或旧代、过期 holder 全部拒绝。当前 worker 依序处理 PENDING → RUNNING → PREPARED → SENDING → SENT。RUNNING 在调用 provider 前提交，SENDING 在调用 sender 前提交。这样中断的代价是可见隔离，包括调用前就崩溃的保守隔离。

**合成例子。** worker A 的 lease 到期，B 获得更高 epoch；A 的 transition 抛 LostLease。忽略 signal 的 sender 被 timeout race 结束等待后仍写出一个“迟到效果”，ledger 继续 QUARANTINED，下一 turn 不运行。provider 也用同样 fixture，不能靠“它通常是纯文本”放宽通用语义。

**验收。** 测试覆盖并发 acquisition、旧代写入、撤权、provider/sender deadline、迟到效果，以及 run/send 各提交点的 crash hook。PREPARED 恢复使用回复而非重跑 provider，SENT 终态去重。FAILED 只来自可信 sender 的明确未送达报告；异常和其他结果均隔离。隔离阻挡同会话后续上下文，避免把未知 turn 静默删掉。

**限制。** Promise race 不停止代码，AbortSignal 是协作取消。authorize/store 调用没有无限等待的硬隔离机制，过期会拒绝提交；当前 demo 是合成内存调用。fencing 不阻止不理解 epoch 的远端请求，没有 exactly-once 远端承诺，也没有人工解除隔离实现。原 demo 的异常自动重试被精确改成隔离断言，真实故障覆盖仍在。

## 6. Markdown、revision、容量与快照

**问题。** “我已记住”是 provider 文本，不是持久回执。独立保存回复和记忆可能在恢复时混入两个版本；只限制入站也挡不住累计回复和 Markdown 增长。

**决策。** provider 返回统一 `{text, memoryMarkdown}`；ledger 原子提交 reply、当前 scoped Markdown、revision 后进入 PREPARED。所有 mutation 检查 JSON UTF-8 850000 bytes 上限；admission/PREPARED 只用 848976 bytes，预留 lease/status/reason 空间；最多 100 turns。checkpoint 超限会拒绝全部内容修改并隔离，不发送。不能删 dedup 记录来“修复”容量。

**合成记忆目标例子，未实现产品策略。** “这次只要短答”不自动固化为长期偏好；“已确认更正为茶”应覆盖原先的咖啡，恢复不能复活旧值。当前 synthetic provider 只保持传入 Markdown，测试 provider 可提出新 Markdown；本核心没有自然语言提取、确认、临时/长期分类或更正算法。已经实现的是 scope 索引隔离和 revision 提交/恢复，不把目标例子算成已支持。

历史 record 保存 reply/revision，不保存每个 revision 的 Markdown 副本；session Markdown 是当前值。PREPARED 后撤权取消送达不会撤销已提交记忆。MemoryState 的提交易失，provider 的 durable 字段一律没有证明力。耐久承诺来自真实持久事务端口或显式完成的文件保存。

FileSnapshots 先临时写、同步、rename、目录同步，envelope 检查大小与摘要，load 核对 scope/schema/revision/capacity。1 MiB 是文件上限，可能因 JSON envelope 转义先于 session 上限触发。恢复前必须停止旧 writer，load 清 lease 只适用于这个条件；不提供跨进程事务，也不提供旧 revision-less 快照迁移。

**未来 GCS 协议，未实现 pointer。** object name 定位对象；generation 选精确版本；size/digest 检测字节；manifest 将 scope、checkpoint revision 和所需文件绑定；pointer 表示选择已提交 manifest 的位置。合成 manifest 可以描述 `scope=S, revision=7, object=S/checkpoint.json, generation="17", size=N, sha256=H`，这些是符号，不是真实资源或 upload 回执。

**官方事实短注。** generation 标识精确数据版本，不保证递增；写入 ifGenerationMatch=0 检查没有 live 对象。412 只说明本次前提失败，前次响应丢失时仍需核实写入结果。来源：[对象元数据](https://docs.cloud.google.com/storage/docs/metadata)、[请求前提条件](https://docs.cloud.google.com/storage/docs/request-preconditions)。已核对文档不等于 SDK/GCS 运行验收，后者仍为 NOT RUN。

目标顺序为 create-only 上传 → 获得可信 generation/size → 写一致 manifest → 以预期 pointer revision 做 CAS。上传后指针前崩溃留下未引用对象，不应自动选最新文件；CAS 冲突时保留原 pointer，不覆盖新 writer 的选择。当前 GcsSnapshots create 只返回 digest，不能构造可信已提交 pointer。摘要不能认证能重算摘要的攻击者。Hermes SQLite 一致性备份与 Markdown 同步仍未实现；不复制活动 DB/WAL 或宣称 GCS 运行盘。

**验收与限制。** Unicode admission、reply 增长、Markdown 增长独立测试；失败保留旧 revision/记忆且不发送。真文件与新 Node 子进程恢复核对 reply revision 与 Markdown 同版本。损坏、跨 scope、非法 checkpoint 拒绝。数据库 SDK 编码大小、云持久性、native Hermes 和恢复 pointer 为 NOT RUN。

## 7. Cloud Run 角色、生命周期与配置责任

**问题。** 容器能启动、并发设为 1、队列有名字，都不能单独证明身份验证、持久化或跨版本安全。请求结束后的后台工作也容易被误当成已完成任务。

**一般设计决策。** ingress 负责认证和 admission/enqueue；worker 负责当前授权、fencing 和执行；持久 store 负责提交语义。凭据最小化，ingress 不需要 bot/provider 外发凭据。网络可达不等于 IAM 可调用，worker 要按真实部署验证 OIDC issuer/audience/invoker。真实 OAuth、Secret Manager、IAM、queue/storage 都需要独立集成，本批没有接线或收集认证文件。

请求 deadline 结束平台等待，应用 timeout 结束一个调用等待，AbortSignal 请求合作取消，lease 控制存储提交；四者不互相替代。滚动版本重叠下的多个 writer 要靠 fencing；不能从并发/实例配置推导单写者。长工作必须有明确生命周期和持久进度，不能只留一个 request 后 Promise。

**官方事实短注。** 默认可写容器文件系统计入实例内存，实例停止后不保留，外部挂载另论。request-based 按请求阶段分配 CPU（启动/关闭另有规则），instance-based 在实例生命周期内分配 CPU；后台 CPU 或最小实例均不保证实例永存或任务必完。来源：[容器运行契约](https://docs.cloud.google.com/run/docs/container-contract)、[CPU 分配](https://docs.cloud.google.com/run/docs/configuring/billing-settings)。

Cloud Run service 504 不终止容器；Cloud Tasks dispatch deadline 不证明 worker 停止，service request timeout 不能与 jobs task timeout 混用。来源：[service 请求超时](https://docs.cloud.google.com/run/docs/configuring/request-timeout)、[Task dispatchDeadline](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks#Task)。

**验收与限制。** YAML 保持 smoke 占位，未部署、未调用真实云。没有给具体权限角色配方、费率或配额。RUNBOOK 区分六项已核对官方行为与剩余待核验项；具体 IAM/OIDC、Secret Manager/provider OAuth、Firestore 编码/事务等仍待核验。文档查证是 STATIC REVIEW，真实云/SDK/IAM 运行验收仍为 NOT RUN。

## 8. 构建、源码上传和公开表面

**问题。** `.dockerignore` 只控制其构建上下文，不能阻止另一种 source upload 把日志、凭据或运行文件上传。镜像、源码包、Git 历史的内容也并不相同。

**决策。** `.gcloudignore` 独立采用 allowlist：Dockerfile/package/LICENSE/NOTICE 与顶层 src `.mjs`。Docker context 保留既有窄规则，最终 COPY 只选 package/src/LICENSE/NOTICE。RUNBOOK 给出逐文件离线清单；测试拒绝未知 src 文件类型与 symlink，并检查禁入样本。无自动构建/部署脚本，不将本地证据加入公开文件。

**官方事实短注。** `.dockerignore` 不替代上传的 `.gcloudignore`/`--ignore-file`；实际上传前要在正确根目录核对 `gcloud meta list-files-for-upload` 和实际命令，文件清单也不替代内容隐私检查。来源：[gcloudignore](https://docs.cloud.google.com/sdk/gcloud/reference/topic/gcloudignore)、[run deploy](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)、[builds submit](https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit)。

**验收与限制。** release 测试是离线规则/文件检查，未运行 gcloud、Docker 构建或上传。上传过滤规则已核对官方文档，实际上传清单与镜像验收仍为 NOT RUN。基础镜像标签不等于锁定 digest，未来构建需审阅精确版本。Git 基线不引入私人历史；合法版权和公共仓库链接是窄范围允许内容。

## 9. 分层证据与脱敏报告

**问题。** fake 成功容易被包装成 SDK/云成功，异常注入也容易被包装成真实进程 kill。一个总数会掩盖这些差异。

**决策。** STATIC REVIEW 说明文件/契约审阅；LOCAL UNIT 说明状态/故障 fixture；LOCAL PROCESS 说明 loopback 或新 Node；SDK FAKE 说明注入接口；EMULATOR、REAL CLOUD、USER FLOW 此轮全部 NOT RUN。每个报告包含实际命令、版本、场景、结果和限制。完整验收摘要只记录脱敏结论，不粘贴会话、正文或原始 provider errors。

**验收。** 对同 ID 重复与并发 drain、冲突 payload、scope、三个授权边界、方法/路径/secret、分块大小/JSON/中止/超时、provider/sender 未知结果、PREPARED/SENT 新进程、容量与损坏分别断言。新 Node 子进程只返回状态/调用计数/revision 匹配布尔摘要。恢复文件使用测试专用临时目录，finally 清理，不纳入 source upload。

**限制。** 本批没有 emulator、真实云、真实用户体验、模型正确性或 native Hermes 验收。旧提交的 CI 不能为新代码背书；代码提交 `67d18a2b0b577970a1cc9d07ea404157f66e01d0` 已通过 [Node 22/24 的 CI 验证](https://github.com/alanxiaofeifei/companion-cloud-starter/actions/runs/38040415468)，该结果仅证明该固定提交的测试与语法检查。

## 10. 运维、回滚和后续边界

**问题。** 回滚代码不能自动回滚数据；隔离不是一个可以随意清掉的错误标记。自动删除记录也会丢去重与恢复证据。

**决策。** 运维先观察最小状态元数据，再对未知效果取得外部依据；当前核心无自动解除隔离。恢复在隔离位置验证 schema/scope/revision/checksum，停旧 writer 后再切换。镜像回滚需先检查数据兼容，不独立回退 memory 或 reply。retention、TTL、生命周期、归档与删除政策不在 A 批实现。

下一步应选择一个已经明确的契约缺口，例如可信 upload generation 接口或持久 dispatch intent，并单独定义故障矩阵和授权；不从本地演示扩成未知场景的 agent 平台。本轮只保留工作区供审阅，没有发布、push、PR、部署、云资源修改或真实外发。
