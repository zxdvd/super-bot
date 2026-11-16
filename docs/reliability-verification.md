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

## 第二阶段：重启恢复仍缺什么

1. 自动 Run 的 turn/seq 关联仍主要为进程内 Set，重启统一把 unfinished Run 变为 recovery；尚不能从持久消息/最终报告/所属 turn/end 做精确、幂等的只读重建。应先落持久关联与分类器，再评估何种事实足以安全补结算，未知副作用不自动恢复执行。
2. 需要细化崩溃窗口：入队未 entered、ready 已提交但 end/结算未提交、turn/end 持久化失败、结算事务/回执丢失、人工下一轮已开始后宿主重启、停止超时后迟到结束。现有一次真实 SIGKILL 只覆盖 running/entered 路径。
3. 重启后后台 CLI/子 Agent 的外部效果不能由“新 Job 列表为空”证明停止；不能自动清空 resources 或盲目重投。未消费的旧 Inbox、人工新消息和恢复动作的排序需要单独验证。
4. 兜底 whenIdle 路径仍不是每个 input 的持久完成证明；下一阶段应统一按所属 turn 的持久证据结算，并保持同一事务/幂等约束，避免仅凭历史 ready 报告补成功。

未验证：真实模型工作质量、浏览器 ↑ 按钮点击/QueueDock 样式、Desktop、真实外部 CLI 作业跨重启的存活。浏览器最小补验仅需在一次测试 Worker 运行时排队一条消息并点 ↑，确认输入进入当前轮且按钮不因插件取消而变灰；核心宿主路径已真实覆盖，不把这项 UI 核对当成已完成。
