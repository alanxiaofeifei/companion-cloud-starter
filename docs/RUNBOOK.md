# 本地验证与后续运维责任

## 离线验收

不运行 npm install；项目仅用 Node 标准库。运行 `npm run check` 会执行全部测试，再对 src/test 所有 `.mjs` 做 `node --check`。本次 Node 24.19.0 的本地结果见交付摘要；Node 22 和此次远端 CI 未运行。

| 证据等级 | 此目录的证据 |
| --- | --- |
| STATIC REVIEW | 默认 smoke、部署占位、源码上传 allowlist、许可和公开文件审阅 |
| LOCAL UNIT | trust/scope、并发/冲突、fencing、撤权、超时、容量、损坏 |
| LOCAL PROCESS | loopback HTTP；真实文件 + 新 Node 进程 PREPARED/SENT 恢复 |
| SDK FAKE | 注入的 Firestore/GCS 接口，未安装 SDK |
| EMULATOR / REAL CLOUD / USER FLOW | NOT RUN |

测试、demo 都无外网、真实模型或 Telegram 调用。没有 OS kill 故障测试；异常 hook 不等于进程死亡，新进程恢复不等于 Cloud Run 重启。合成数组允许展示公开 fixture；日志不得复制正文、Markdown、认证头、raw identity 或 provider error。

## 四种发布面分别审阅

Git 内容、source upload、Docker context、最终 image 是不同边界。`.dockerignore` 不能控制源上传，忽略规则也不能洗掉已经提交的历史。发布前核对逐文件类型、大小、symlink 和 diff；保留原 MIT/NOTICE 归属。没有第三方 runtime 材料，不声称 native Hermes 集成。

`.gcloudignore` 使用窄 allowlist，离线预期上传清单为：

```text
Dockerfile
package.json
LICENSE
NOTICE
src/demo-server.mjs
src/demo.mjs
src/ingress.mjs
src/runtime.mjs
src/server.mjs
src/snapshot.mjs
src/state.mjs
src/storage.mjs
src/worker.mjs
```

`node --test test/release.test.mjs` 校验规则、当前 src 的普通文件类型和禁入样本；是本地清单检查，没有运行 gcloud。上传过滤的官方规则已核对，实际上传前仍需核对命令和最终清单，见下节来源。测试、文档、运行数据、凭据与本地证据不在这个上传 allowlist 中。Docker context 只允许 package/src/LICENSE/NOTICE，Dockerfile 指令只复制这些文件；未构建 image，本次没有最终镜像内容验收。基础镜像仍是 smoke 标签占位，部署前应选择经审阅的 digest；不新增部署脚本。

## 一般云角色：待真实集成

公开 ingress、队列调用方、worker、持久存储应有明确身份和职责。ingress 只需接入验证与最小 admission/enqueue 权限，不需 provider 或 bot 外发凭据。worker 需要当前 policy、session store 和指定 provider/sender 权限。采用工作负载身份和按资源授权；网络可达性与 IAM 调用许可分开验证，不能靠注释推出认证成立。

真实 provider OAuth、Secret Manager 引用、OIDC issuer/audience/invoker、IAM、queue 和 storage 接线均未实现/未验收，不收集登录文件或密钥。一般配置建议不是具体角色配方。Cloud Run YAML 继续只展示 smoke 占位。

请求结束后的背景 Promise 不能当成耐久作业。长任务需明确请求/作业生命周期、持久进度和下一次唤醒；没有调用 reconciler 就没有自发恢复。平台请求 timeout、应用等待 deadline、lease expiry 和 cooperative cancel 是四件事。并发=1 或单实例配置不能替代滚动版本重叠时的 fencing。真实行为必须由部署事实与请求验收确定。

## 已核对的官方行为与来源

以下六项已完成官方文档核对，属于 STATIC REVIEW。文档查证与真实云/SDK/IAM 行为的运行验收是不同证据；后者仍为 NOT RUN。

- 默认 Cloud Run 可写容器文件系统计入实例内存，实例停止后不保留；另行配置的外部挂载需另论。来源：[容器运行契约](https://docs.cloud.google.com/run/docs/container-contract)。
- request-based 在处理请求时分配 CPU（启动/关闭阶段另有规则）；instance-based 在实例生命周期内分配 CPU，可用于响应后的后台处理。后台 CPU 或最小实例均不保证实例永存或任务必完。来源：[CPU 分配](https://docs.cloud.google.com/run/docs/configuring/billing-settings)、[实例生命周期](https://docs.cloud.google.com/run/docs/container-contract)。
- Cloud Run service 请求超时返回 504，不终止容器；Cloud Tasks dispatch deadline 结束等待也不证明 worker 停止。超时不能证明副作用未发生；service 请求超时与 jobs task timeout 不可混用。来源：[service 请求超时](https://docs.cloud.google.com/run/docs/configuring/request-timeout)、[Task dispatchDeadline](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks#Task)。
- 创建任务、ALREADY_EXISTS、任务消失都不证明业务成功；ALREADY_EXISTS 可能来自近期已执行或删除的记录。HTTP 2xx 是队列成功确认，不能提前确认再依赖后台失败触发重试；任务名去重不提供 exactly-once 外部副作用。来源：[任务创建](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create)、[重复执行](https://docs.cloud.google.com/tasks/docs/common-pitfalls)、[Cloud Tasks 确认语义](https://docs.cloud.google.com/tasks/docs/dual-overview)。
- generation 标识精确对象数据版本，不保证递增；写入时 ifGenerationMatch=0 检查该名称没有 live 对象。412 仅说明本次前提失败；若前次写入响应丢失，仍需核实结果，不能据此判断业务成败。来源：[generation](https://docs.cloud.google.com/storage/docs/metadata)、[请求前提条件](https://docs.cloud.google.com/storage/docs/request-preconditions)。
- `.dockerignore` 不替代源码上传的 `.gcloudignore`/`--ignore-file`。实际上传前，在正确上传根目录核对 `gcloud meta list-files-for-upload` 和实际命令的 `--ignore-file`；文件清单不替代内容隐私检查。来源：[gcloudignore](https://docs.cloud.google.com/sdk/gcloud/reference/topic/gcloudignore)、[run deploy](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy)、[builds submit](https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit)、[Docker 过滤示例](https://docs.cloud.google.com/run/docs/quickstarts/build-and-deploy/deploy-php-service?hl=en)。

## 仍待核验或运行验收

以下具体集成细节仍待核验；不写具体费率、配额或未经核对的平台结论：

- Cloud Run 的具体并发、实例重叠与 shutdown 配置行为。
- IAM 的最小角色/资源范围、服务身份、worker invoker 与 OIDC audience/issuer 检查。
- Secret Manager 与 provider OAuth 的访问、轮换和持续认证责任。
- Queue 的具体保留、重试、deadline 配置与持久唤醒接线。
- Firestore 事务重试、真实编码大小、并发与提交错误语义。
- GCS SDK upload 元数据、pointer CAS 协议接线与一致性验收。
- 实际 gcloud 上传清单、Docker context 与最终 image 的内容验收。

这些运行验收全部 NOT RUN；fake 不证明官方 SDK、IAM 或云持久化，已核对的官方文档也不证明本应用实现正确。

## 恢复、隔离与回滚

恢复先停止源 writer，在隔离位置校验 snapshot 的 scope/revision/checksum/capacity，再恢复一个新 store。QUARANTINED 需要有依据的人工判断；本核心没有清隔离 API，也不自动重发。最小进度监控可以只统计状态数量和无个人语义 trace，当前没有生产监控模块。

镜像回滚前核对 schema/manifest 兼容性；镜像回滚不等于数据回滚。retention、TTL、生命周期、永久删除与归档都是独立政策，本批不实现。发布、push、PR、镜像上传、云资源修改、真实外发与凭据配置都不属于离线验收；此目录没有自动执行入口。
