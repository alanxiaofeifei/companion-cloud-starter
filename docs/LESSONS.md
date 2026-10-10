# 可复用工程取舍

1. **让可运行示例与核心共享实现。** 另写一个简单 worker 容易留下两种失败语义。demo 现在只组合端口，失败覆盖改为现有 ledger 的隔离断言。
2. **权限由可信输入与当前 policy 决定。** 通道 secret、成员授权、scope 索引和工具权限分别承担不同职责；正文与模型不能授予身份。
3. **先规定提交边界，再讨论“记住了”。** provider 的回复与 Markdown 是提议，PREPARED revision 才是 ledger 提交；易失 store 的提交仍不等于耐久存储。
4. **未知结果要成为可见状态。** deadline 结束等待，signal 允许合作取消，二者不证明外部效果不存在。忽略 abort 的迟到效果测试让这个区别可复现。
5. **容量要覆盖结果增长。** admission 限额不足以保护累计回复和记忆；每次 mutation 的总上限、检查点内容预算和隔离空间都需要验证。此参考核心拒绝增长，不增加归档框架。
6. **队列存在不等于业务完成。** inbox、turn、dispatch intent、task 身份分离；确定 task 名称不能替代 ledger 终态，也不能建立 exactly-once 外部送达。
7. **文件、manifest、pointer 分别有职责。** 摘要不认证写者，generation 不表达一致 revision，上传成功不表示恢复 pointer 已提交。真实 SQLite/Markdown 一致备份仍是独立任务。
8. **按证据等级描述能力。** SDK fake、异常 hook、新 Node 进程恢复、OS kill、真实云恢复不能互相继承结果。健康检查只证明 smoke 可用。
9. **发布面单独缩小。** Git、源上传、Docker context、最终 image 分开检查；不要把原始运行证据放进公开工程材料。现有合法版权不能为了去身份化而删除。
10. **记忆产品语义需要另外实现。** 临时偏好不固化、更正覆盖旧值是目标例子，本核心只传递 scoped Markdown，不能宣称已实现自然记忆策略。

这些是当前代码与合成故障得出的通用取舍，不是性能报告或生产上线证明。
