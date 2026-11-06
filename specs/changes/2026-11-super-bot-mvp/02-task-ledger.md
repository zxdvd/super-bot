# 02 Task Ledger

职责：唯一业务写入口，保存责任、输入、版本、结果与控制状态。

## 对象与事务

沿用基线的 Bot、Task、SessionBinding、Run、Result、Review、Attention，增加内部 Input、Event、Outbox、幂等记录和资源占用记录；内部记录不增加用户概念。

- Task lifecycle：open / review / completed / cancelled。controlMode：auto / paused / manual。取消请求可以先记为待处理控制意图，直到执行收敛才进入 cancelled。
- Run：queued / running / settled / failed / cancelling / cancelled / interrupted；终态只记录一次。未知执行事实保存在资源占用与恢复事项，不把 failed 当作可安全重试。
- 幂等键在用户本地账户/调用者命名空间中唯一，并保存命令名与规范化 payload hash；同键不同命令或内容拒绝。Input、Report 各自去重。
- 更新已有对象使用 expectedRowVersion；结果、Review、报告另带 taskRevision/resultId/bindingGeneration。陈旧报告保留审计但不进入当前事实投影。
- 部分唯一约束保证一个 Bot 一个当前 Manager、Task 一个当前执行绑定、同一 Session 一个未结束任务。资源占用另行防止跨 Task 双跑。
- 任务范围不完整可持久创建，但不可派发，建立一个具体澄清事项。

命令最少包含 task.create/revise/dispatch/control、session.attach/detach、work.report/ask/read、task.review、attention.respond、result.accept；查询包括 bot.summary、task.list/detail、分页 events/results。版本冲突返回明确错误和刷新提示，不静默覆盖。

## 迁移与恢复

SQLite 位于本地磁盘。schemaVersion、事务、唯一约束、Outbox 和审计先建立；未知新 schema 或迁移失败禁止调度。启动先取得控制目录独占权并完成核对，再恢复派发。锁失效后如何重新获取须经过宿主/进程核验，不能只按时间抢占。

数据库与 DSH 外部写入不共事务：创建 Session、投递输入、通知各有 Outbox 类型与恢复证据。外部状态不确定时进入 recovery；通知失败只重试通知。

验收：T04、T06、T10、T13、T15、T16、T17。实现：SB-03～09、SB-12～14。
