# 03 Session Execution

职责：DSH 适配、Session 绑定、输入投递、事实归一化、容量、停止与恢复。

## 关联与派发

新任务默认普通 Root Session。已有 Session 只经用户确认目标、历史读取与自动管理授权后关联；拒绝跨 Bot 静默接管。关联前核对后台活动、待处理输入和权限。未知活动则保持观察状态，不派发。

每次派发绑定 taskId、runId、inputId、taskRevision、bindingGeneration 与实际 MessageId/turn 引用。报告身份从实际工具作用域获取。若子 Agent 可以继承报告工具，必须由 Adapter 显式验证执行树归属，默认仅根 Worker 可提交最终 ready。

Input 追踪 accepted→enqueued→entered（或 discarded/unknown）。Inbox claimed 不能直接等同于 entered；准备阶段取消时，输入可能未进入持久 user/message。没有宿主事实不显示“已读”。

单任务、单 Session 只允许一个未收敛 Run。不同 Session 仍须检查规范化写目录和资源占用。`realpath`/父子目录重叠需要识别；独立 worktree 只隔离 checkout，不隔离共享数据库、端口或 Git 外部副作用。

## 停止、接管与重启

暂停/接管禁止后续自动派发，当前 Run 可继续；停止先持久化控制意图、阻止 Outbox 新投递，再请求 DSH 停止并核对工具、作业、子 Agent 和插件自有待处理输入。

目标 Web rc.1 的 Session cancel 会 keepInbox；真实探针证明已 claim 但未进入 user/message 的普通输入仍可能消失，不能由 Inbox 缺失推断消费。适配器须定向撤回能证明属于当前 Run 的输入，不能清空用户输入；不能定向撤回或确认停止就进入 recovery。取消 accepted 只是回执。whenIdle 不是某个 input 的完成凭据，也不自动涵盖所有外部后台效果。

原生用户输入若可可靠识别并在派发前形成顺序屏障，则转 manual；已在执行的动作记录为干预前发出。如果宿主不能提供该边界，首版明确要求显式接管，关闭自动原生输入检测承诺。恢复时核对期间新输入和目标，创建新 Run。

重启恢复先读持久事实、核对运行与资源：可关联的旧执行继续观察；确认中断则终结旧 Run，显式恢复后新建 Run；未知投递/副作用不重投。事件游标随同应用变更事务提交，重复事件可安全回放。

## 能力门槛

具体调用以 [证据页](evidence.md) 的目标版本探针为准。停止/作业/人工输入/审批缺能力时对外暴露降级；工具作用域无法强制隔离时禁止自动管理，不能用 Prompt 弥补。

验收：T01、T04、T06、T08～T11、T13、T16、T19。实现：SB-01、02、05、06、09、12、13。


### 当前纵切边界

先交付专用目录文件工作：只放行 read/write/edit 与报告，目录约束由适配层检查；不是操作系统沙箱。Shell/子 Agent 的业务开放后置到相应停止探针与策略完成。单 Run 上限 10 分钟、停止确认等待 10 秒，超时转待核对并保留资源；全局最多 2 个持有资源的 Run。

回答和人工返工先保存 Input/Outbox，由用户再次开始投递；回答进入上下文才解决原问题。新一次执行使用新 Run，继续同一原生 Session；它不增加目标版本或自动返工次数。自动调度与 Manager 在后续任务接入。
