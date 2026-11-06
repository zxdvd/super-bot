# 当前运行能力与降级

验证目标：DSH Web `0.2.2-rc.1`、Node `24.21.0`、SQLite `3.53.4`。独立 home/profile 使用无网络确定性模型，调用真实 DSH API、文件工具、原生审批和会话运行时。这里的“已验证”不代表真实模型的工作质量。

| 能力 | 当前结果 | 产品行为与证据 |
| --- | --- | --- |
| 安装、启动、原生会话导航 | 已验证 | 官方插件安装；单独 Web profile；停机卸载/重装保留数据。独立 UI 多轮通过 |
| 准备新的任务会话 | 已验证 | 预分配 Session ID、持久创建意图；丢回执后只核对同一个会话。`probe:run` |
| 关联已有普通会话 | 已验证 API 与 UI | 双授权、有效目录检查、关联后暂停；已有归属拒绝。`smoke-attach.mjs` 包含并发竞争和普通 fork |
| 部分会话历史授权 | 不提供 | 原生模型仍能读取既有上下文；仅支持明确授权整段历史，或另建全新会话 |
| 输入送达与消费 | 已验证；存在宿主限制 | accepted/enqueued/entered 分开。已 claim 后取消可能丢失 Inbox 项且无 user/message，转人工核对，不推断已消费。`probe:run` |
| 文件任务工具范围 | 已验证 | read/write/edit 与报告；绝对路径、实际目录、符号链接检查；额外 scoped 工具再由执行 guard 拒绝。`smoke-directory.mjs`、`smoke-scoped-tools.mjs` |
| Shell、子 Agent 业务派发 | 未开放 | 已验证子 Agent 归属和工具继承契约；产品仍仅开放文件工具，不能推断任意外部进程可停止 |
| ready 与最终验收 | 已验证 | ready 只是候选；执行收敛和文件完整哈希均需核对。默认人工；显式 Bot 授权保持独立审计。`smoke:execution`、`smoke:workflow`、`smoke:manager` |
| 长文件验收 | 限制明确且已验证 | 每项只预览前 12,000 字节；完整文件用于哈希核验。超出预览范围必须人工检查全文。`smoke-manager-rework.mjs` |
| 原生工具审批 | 已验证文件写入三路径 | 允许一次、拒绝、等待时停止；工作台只显示待办和跳转，决定来自原生 UI。独立 UI 第 13～14 轮、`smoke-approvals.mjs` |
| 人工接管 | 已验证 | 原生用户输入撤销旧 Run 授权；收敛前限制不解除；旧 driver 空闲后允许新人工轮次使用原生工具。旧 Stop 回执不取消新工作。`smoke-handoff.mjs` |
| 普通停止与未知停止 | 已验证 | cancel 回执不算结束；真实 10 秒不响应取消转恢复；迟到收敛不伪造成功。`smoke:execution`、`smoke-stop-timeout.mjs` |
| Worker 预算 | 已验证 | 每 Run 最多 40 步或 10 分钟；实际 40 步和 600,026 ms 计时通过。预算后暂停并核对，不自动重试。`smoke-budget.mjs` |
| Manager 约束 | 部分已验证 | 单 Bot 一轮、全局两轮；实际 12 步、自动轮次 5 分钟、每小时 20 次唤醒及换会话不重置额度均通过 `smoke-manager-budget.mjs`。手动管理对话受 12 步限制，没有自动轮次计时器；全局两轮并发的专门压力用例待补 |
| 两个 Worker 容量 | 已验证 | 同 Bot 两项实际同时运行；第三项不创建 Run，另一个 Bot 的 Manager 等待名额，释放后才派发。`smoke-capacity.mjs` |
| 后台作业收敛 | 已验证契约；产品能力有限 | Agent idle 不代表 job 停止，kill accepted 不代表 settled。合成 job 探针及 `smoke-background.mjs` 实际 ready→恢复门槛验证；不开放业务 Shell |
| 重启与未知投递 | 已验证主要窗口 | 实际 SIGKILL、投递后丢回执、Manager 通知丢回执均不自动重放责任。`smoke-restart.mjs`、`probe:run` |
| 账本迁移和恢复 | 已验证主要窗口 | schema 2→6、失败回滚、未提交升级进程中断、一致性快照、新目录恢复。`npm test`、`smoke-restored.mjs` |
| Dashboard 离线 | 已验证 | 仅保留快照并禁用变更；重连不重放操作，恢复筛选和位置。100 项分页通过 |
| 运行中热卸载/热替换 | 未验证 | 目前使用停止宿主→卸载/更新→重启的操作方式 |
| Desktop | 未验证 | 本机 `0.2.1-rc.5` 未接入验证；当前安装包目标是 Web rc.1 |
| 真实模型质量、Token/费用 | 未验证 / 未提供精确归因 | 不把确定性测试当模型能力评估；真实账号与最终个人试用留待用户方便时进行 |

目录限制是应用层约束，不是操作系统沙箱，也不把不同 Bot 作为安全租户。既有原生会话的历史、插件和用户手动操作仍属于当前单用户宿主。

详细过程与版本见 [验收证据](../specs/changes/2026-11-super-bot-mvp/evidence.md)，各场景残余缺口见 [验收矩阵](../specs/changes/2026-11-super-bot-mvp/requirements.md)。运行数据仅在 `.runtime`，不随产品包发布。
