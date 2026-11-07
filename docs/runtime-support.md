# 当前运行能力与降级

2026-11-07 已实现聊天主入口，正在用真实 Bot/Worker 修复本仓库。下表区分既有 files 模式的底层证据与 Full Access 增量；局部实测不代表首版全部验收。

验证目标：DSH Web `0.2.2-rc.1`、Node `24.21.0`、SQLite `3.53.4`。独立 home/profile 使用无网络确定性模型，调用真实 DSH API、文件工具、原生审批和会话运行时。这里的“已验证”不代表真实模型的工作质量。

| 能力 | 当前结果 | 产品行为与证据 |
| --- | --- | --- |
| 安装、启动、原生会话导航 | 已验证 | 官方插件安装；单独 Web profile；实际 tgz 全新安装、停机卸载/重装保留数据。独立 UI 多轮通过 |
| 准备新的任务会话 | 已验证 | 预分配 Session ID、持久创建意图；丢回执后只核对同一个会话。`probe:run` |
| 关联已有普通会话 | 已验证 API 与 UI | 双授权、有效目录检查、关联后暂停；已有归属拒绝。`smoke-attach.mjs` 包含并发竞争和普通 fork |
| Bot 配置与参考资料 | 已验证 API 与 UI | 配置版本、最多 4 个本地 UTF-8 文本快照；旧任务保持原配置，变更撤销旧 Manager。`smoke-bot-config.mjs` 含并发重复请求、源文件变化和启用前任务积压 |
| 部分会话历史授权 | 不提供 | 原生模型仍能读取既有上下文；仅支持明确授权整段历史，或另建全新会话 |
| 输入送达与消费 | 已验证；存在宿主限制 | accepted/enqueued/entered 分开。已 claim 后取消可能丢失 Inbox 项且无 user/message，转人工核对，不推断已消费。`probe:run` |
| files 模式工具范围 | 已验证 | read/write/edit 与报告；绝对路径、实际目录、符号链接检查；额外 scoped 工具再由执行 guard 拒绝。`smoke-directory.mjs`、`smoke-scoped-tools.mjs` |
| Full Access 的 Shell、子 Agent | 已开放；真实修复试用中 | 普通 DSH Session 的原生工具已实际执行 Bash 和子 Agent；由现有宿主配置能力，不额外裁剪工具。不能因此推断任意外部进程可停止 |
| ready 与最终验收 | 已验证 | ready 只是候选；执行收敛和文件完整哈希均需核对。默认人工；显式 Bot 授权保持独立审计。`smoke:execution`、`smoke:workflow`、`smoke:manager` |
| 长文件验收 | 限制明确且已验证 | 每项只预览前 12,000 字节；完整文件用于哈希核验。超出预览范围必须人工检查全文。`smoke-manager-rework.mjs` |
| 原生工具审批 | 已验证文件写入三路径 | 允许一次、拒绝、等待时停止；工作台只显示待办和跳转，决定来自原生 UI。独立 UI 第 13～14 轮、`smoke-approvals.mjs` |
| 人工接管 | 已验证 | 原生用户输入撤销旧 Run 授权；收敛前限制不解除；旧 driver 空闲后允许新人工轮次使用原生工具。旧 Stop 回执不取消新工作。`smoke-handoff.mjs` |
| 普通停止与未知停止 | 已验证 | cancel 回执不算结束；真实 10 秒不响应取消转恢复；迟到收敛不伪造成功。`smoke:execution`、`smoke-stop-timeout.mjs` |
| Worker 预算 | Full Access 不附加预算；files 已验证 | 以下只适用于旧 files 模式：每 Run 最多 40 步或 10 分钟；实际 40 步和 600,026 ms 计时通过。预算后暂停并核对，不自动重试。`smoke-budget.mjs` |
| Manager 约束 | 已验证 | 单 Bot 一轮、全局两轮；实际 12 步、自动轮次 5 分钟、每小时 20 次唤醒及换会话不重置额度均通过 `smoke-manager-budget.mjs`。files 模式手动管理对话受 12 步限制，Full Access 为 24 步，没有自动轮次计时器；`smoke-manager-capacity.mjs` 真实两轮占位、第三轮排队与释放后进入通过 |
| Manager 迟到命令 | 已验证 | 模型读取后暂停，用户改目标或在 Worker 原生输入；迟到 dispatch/review 被拒绝。`smoke-manager-stale.mjs` |
| Manager 更换回执 | 已验证 | 重试只对应原准备代数；配置变化后的新 Manager 不被旧请求选择模型。首次继承在原生解析后重新核对当前身份。`smoke-manager-lifecycle.mjs`、5 项适配层回归 |
| 两个 Worker 容量 | 已验证 | 同 Bot 两项实际同时运行；第三项不创建 Run，另一个 Bot 的 Manager 等待名额，释放后才派发。`smoke-capacity.mjs` |
| 后台作业收敛 | 已验证契约；产品能力有限 | Agent idle 不代表 job 停止，kill accepted 不代表 settled。合成 job 探针及 `smoke-background.mjs` 实际 ready→恢复门槛验证；Full Access 的真实 Shell 工作仍依赖原生作业收敛事实 |
| 重启与未知投递 | 已验证支持范围 | 报告/settle/验收事务回滚和提交回执重开、entered 失败、Fake 旧 Agent 存活重装 adapter 均通过。实际 SIGKILL、投递后丢回执、Manager 通知丢回执均不自动重放责任。`smoke-restart.mjs`、`probe:run` |
| 账本迁移和恢复 | 已验证主要窗口 | schema 2→7、实际 schema 6→7、失败回滚、未提交升级进程中断、一致性快照、新目录恢复、schema 6 旧版本实际回退。快照发布后清单中断的重试保留原快照；缺失/损坏文件拒绝成功。`npm test`、`smoke-restored.mjs`、实际安装包 `smoke-backup-retry.mjs` |
| 首次模型选择与错误提示 | 已验证 API 与 UI | 使用原生 modelSelection 投影区分已选模型与默认路由；未选 Worker 不创建 Run，Manager 保留通知/0 次唤醒。真实 turn/end 的缺凭证错误显示明确原因，不抄录提供方原始错误正文。`smoke-model-errors.mjs`、实际 tgz `smoke-package.mjs` |
| Dashboard 离线 | 已验证 | 仅保留快照并禁用变更；重连不重放操作，恢复筛选和位置。100 项分页通过；恢复旧备份时清除失效任务/Bot 选择并钳制页码，同页任务消失路径 UI 通过 |
| 运行中热卸载/热替换 | 仅空闲插件重载实测 | 日常 web profile 空闲时启停本插件，保留账本和原生会话；安装新 tgz 后曾仍运行旧实现，需重载并核实新 Worker 配置。活动执行期间不热替换 |
| Desktop | 未验证 | 本机 `0.2.1-rc.5` 未接入验证；当前安装包目标是 Web rc.1 |
| 真实模型质量、Token/费用 | 未验证 / 未提供精确归因 | 不把确定性测试当模型能力评估；真实账号与最终个人试用留待用户方便时进行 |

files 模式目录限制是应用层约束，不是操作系统沙箱。Full Access 不附加该目录限制，也不把不同 Bot 作为安全租户。既有原生会话的历史、插件和用户手动操作仍属于当前单用户宿主。

详细过程与版本见 [验收证据](../specs/changes/2026-11-super-bot-mvp/evidence.md)，各场景残余缺口见 [验收矩阵](../specs/changes/2026-11-super-bot-mvp/requirements.md)。本仓库测试数据保存在 `.runtime`，不随产品包发布；安装后的账本位置与外部成果范围见 [README](../README.md)。


## 聊天入口增量（2026-11-07）

创建/选择 Bot 直接导航到同一原生对话，任务面板收为“工作与设置”。Manager 的 create/respond/rework 需要本轮实际进入上下文的原生用户消息；来源与原文随账本事件保存，自动通知不能伪造。人类验收仍由原有确定性 UI/API 执行。

`/api/super-bot-file` 是宿主认证下的只读成果入口，仅按 resultId 与文件索引查询账本；无任意路径参数。返回前核对实际文件哈希与大小，单文件保持 10 MiB 上限。聊天交付链接可直接进入对应任务详情，下载文件不会接受成果。

`npm run smoke:chat` 在真实隔离宿主上使用无网络确定性模型验证完整链路；不是语言理解或成果质量评测。聊天增量基线为 52 项核心、16 项适配测试及 11 项真实宿主契约通过；后续新增回归以 evidence 为准。真实模型/Shell 已开始 dogfooding；Desktop、任意外部服务与完整产品体验仍未验收。
