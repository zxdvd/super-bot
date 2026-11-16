# 执行可靠性：隔离宿主验证（2026-11-16，北京时间）

## 范围与隔离

起点为 `dev` 的 `d173295`；开发机和公司机均无未提交改动，远端一致。公司账本只读看到 settled 4、interrupted 1，没有 running/queued/cancelling；开发机活动账本被占用，只读副本的参考结果为 settled 11、interrupted 2、cancelled 1、failed 1，不能据此证明宿主无外部工作。本阶段没有停日常宿主、更新公司插件、修改生产配置/账本或接受/恢复现有任务。

`npm run smoke:reliability` 在 zxds Mac 本地运行，创建全新的 DSH_HOME、profile、操作系统 HOME、账本及工作目录；不继承生产 dataDir、账号或模型凭证。使用 DSH 0.2.2-rc.1 / Node 24.21.0 及确定性 provider，无模型请求/计费。HTTP 测试入口调用真实 sessionController.prompt / updateQueue，同一套原生 Inbox、driver、持久事件、工具与 Job 服务参与；没有人工伪造 turn/end 或 user/message。只结束脚本自己启动的宿主，不使用浏览器或云端执行器。

## 实际复现并修复

原代码在会话级 whenIdle 后结算，但 DSH 同一个 driver 可以连续执行多个 turn，中间并不保证 idle。实测旧代码：ready 已提交，turn 1 的 `turn/end(completed)` 为 seq 31，紧跟 seq 32 的 turn 2/start，人工消息在 seq 35 进入，旧 Run 仍未结算，遂被 nativeIntervention 改成 interrupted 并留下 recovery。

`src/dsh.ts` 改为在匹配的自动 turn/end 检查最终报告、未停止作业/子 Agent 后，结算该 Run 或标恢复；错误/非正常结束、漏报不升级成果。释放本自动轮次的 guard/mask/budget 和执行句柄；保留 whenIdle/idle 作为异常无事件路径兜底，但已完成结算不会再跟随人工轮次。后台效果未知时仍保留资源。人工接管路径也移除旧句柄，避免后续插件退出误取消人工工作。没有更改账本 schema 或 DSH 上游。

## 真实事件与状态矩阵

files（证明工具约束解除）和默认 Full Access 各跑一遍，以下 8 个场景均通过：

| 场景 | 观察与断言 |
| --- | --- |
| 排队→升级插话 | Worker 在 turn 1 中持有模型请求；next-turn 入队后仍 running/auto、signal 未 abort；updateQueue(steer) 将同一输入移到 next-step；在同一个 turn 1 的 seq 24 进入 user/message；write/read/report 后 completed，Run settled/auto，只有一个 turn/start |
| 不升级的下一轮 | turn 1 seq 31/end(completed) → seq 32/turn 2/start → 人工 user/message；Run 保持 settled，没有 recovery，任务 manual；人工 scoped 工具实际成功一次、人工 signal 未 abort；候选文件仍保存，原 review 因人工修改而失效，不伪造接受 |
| 正常完成 | 原生 write/read/super_bot_report → completed → settled，任务待验收，成果未人工接受 |
| 停止收敛中排队人工轮 | 模型暂不响应取消：Run cancelling、paused、人工输入仍待处理；files 模式 scoped 工具此时被旧约束拒绝；释放旧模型后 aborted → Run cancelled → turn 2，人工工具成功，manual 且人工 signal 未 abort；重复旧 Stop 回执不取消新轮 |
| ready 但后台 Job 仍运行 | 真实 Job 注册表中有未完成的合成作业：Run interrupted/recovery，候选成果不能验收；人工新轮可以使用 scoped 工具，不会被旧 guard 误限制；作业停止/完成后不擅自释放该未知 Run 的资源 |
| 模型错误 | 确定性提供方抛出合成 MISSING_CREDENTIAL；turn/end(error)，无成果，Run interrupted/recovery，不重试、不伪称模型已调用 |
| 正常结束但漏报告 | completed 但没有最终 super_bot_report，Run interrupted/recovery，无成果，不推断完成 |
| 进程强制重启 | running 且原生输入 entered 后 flush 会话，再 SIGKILL 仅测试宿主；重启同一隔离 profile，Run/Input ID 均不变、interrupted/recovery，原生会话补 interrupted 结束；resolveAgent 后 idle，测试 provider 调用数为 0，短观察窗口内不自动重投；没有执行恢复确认 |

每个模式结束后离线只读核对账本：settled 3、cancelled 1、interrupted 4；running/queued/cancelling 为 0。resources 仍保留 4，humanAcceptedAt 非空为 0，符合未知效果保守保留的策略。

最终隔离证据目录（只在开发机，raw host.log 包含本机启动 token，不要外传）：
- `.runtime/reliability-ew4Gvf/`：files 模式，含每场景 observations JSON、重启前后宿主日志及独立账本。
- `.runtime/reliability-KlT8by/`：Full Access，同上。

完整 `npm run check` 通过：23 个 UI 文件行长检查、TypeScript、87 个单元测试、139 个适配层测试（含本次新增 6 项收敛回归）、build；合计 226。隔离宿主矩阵独立于 npm check 执行。

## 第二阶段：持久证据与崩溃窗口

阶段二起点为 `63294bf`。实现于 `src/dsh.ts`、`src/run-proof.ts`、`src/store.ts`：新 Run 预留证据行，自动输入 entered 时记录 turn/startSeq/inputSeq；原进程在该 turn/end 同步记录 endSeq/endKind、最终报告 ID 和 Job/子 Agent 已收敛的快照。随后调用 SessionStore.flush，再通过 SessionPersistence 只读验证连续日志、完整输入身份、唯一所属轮次与结束事件。DSH 持久事件是不可变连续前缀，append 本身为 best effort，flush 才是持久屏障；尾部缺失或坐标不符不推断成功。启动恢复不 resolveAgent、不检查新进程空 Job 列表、不执行模型/工具。结算和资源释放在同一 SQLite 事务；恢复成功暂停任务，不新发 Manager 唤醒、不验收成果。

恢复宿主沿用同一隔离 home/profile/账本。每个窗口执行 prepare → SIGKILL → restart/verify → SIGKILL → restart/verify，并重复原 dispatch request 验证 Run/Input ID 不变且不会再次发输入：

| 窗口 | 持久事实与恢复断言 |
| --- | --- |
| ready 已保存，turn/end 前崩溃 | ready 不是结束证明；interrupted/recovery，原资源保留，模型调用 0 |
| 原 turn/end 持久化后、账本结算前崩溃 | 测试 flush hook 阻塞但真实持久化监听器并行完成；原进程 quiet + 精确 completed 日志，补 settled/paused，释放资源，无人工接受 |
| 账本已结算、进程清理前后重启 | 保持原 settled/结果 ID，无二次结算/调用/输入 |
| inbox 接受后 dispatch 回执丢失 | 保留原 interrupted Run 与锁，不把重试当新尝试，无自动输入重投 |
| turn/end 时有未知后台 Job | quiet=0，即使重启后注册表为空也不能释放，仍 recovery/锁定 |
| 未 entered 的自动输入与人工输入一起持久排队 | 空闲兜底标 recovery；恢复不主动加载 Agent，之后 Agent 创建时仅清除精确匹配的旧自动输入，人工输入保留，不唤醒、不把 unknown 改成 entered |

另有适配层故障注入：日志缺尾/断序/重复输入/错身份/跨轮、aborted、flush false/抛错、Stop 与 flush 竞争、SQLite 结算中断回滚后重开、旧版本迁移和重复恢复。Stop 只终结旧 Run，不取消已经开始的人工 driver；人工续轮不会阻止旧轮次按持久证据结算，也不会让旧成果被误验收。

### 迁移与运维边界

- 实际前版 schema 为 8（上文阶段一旧运维说明曾滞后）；本次升级到 9，事务新增 run_turns，旧 Run 无证据行，不从历史 ready 或新 Job 空表补造证据。已有 settled 不重开，旧 interrupted 不自动复活，历史锁保留。旧插件拒绝打开 schema 9；部署前备份，回退只能用对应旧插件/恢复脚本与升级前备份到新目录。
- 恢复只收敛账本，不恢复执行、不重投模型/工具、不自动验收；未知效果须人工核对。显式备份恢复流程仍统一暂停并待核对，与原 profile 重启后的证据补结算是两条路径。
- quiet 仅覆盖宿主可追踪 Job/子 Agent。任意 detached OS 进程、外部系统副作用不受证明；没有权威 end 或边界 quiet 时宁可保留锁。持久化/读取无限挂起需运维处理，不超时猜测完成。
- 极窄窗口（原进程观察 end 前即崩溃、证据事务未提交、旧输入正在被另一个已运行 driver 领取）仍保守 recovery；不承诺通用跨系统 exactly-once。隔离 SIGKILL 不是整机断电/fsync 硬件验证。
- 本阶段不更新/重启公司生产、不修改现有任务、配置或账本。浏览器 ↑ 按钮/QueueDock、Desktop、真实模型质量与真实外部 CLI 跨重启存活未重测。最小 UI 补验仍是运行中排队并点 ↑，确认当前轮消费且按钮不因插件取消变灰。

### 阶段二最终验证

`npm run check`：行长检查、TypeScript、87 个单元测试 + 160 个适配层测试（共 247）、build 全通过。files 与 Full Access 均通过原 8 场景 + 新增 6 崩溃窗口（每窗口恢复两次）；恢复后模型调用均 0、原 Run/Input ID 不变、未自动验收，安全窗口释放锁，未知窗口保留锁。最终证据目录为 `.runtime/reliability-23nUE3/`（files）与 `.runtime/reliability-r8vQdI/`（Full Access）；原始宿主日志含本机 token，不外传。

补结算不会新增 Manager 唤醒；既有 Manager 通知/投递队列仍按原规则运行，不代表全宿主启动时禁用其他既有任务。恢复补结算的任务被暂停，即使 reviewPolicy=bot，Manager 也不能自动验收或继续派发。完整通知/投递可靠性不在本阶段扩展。
