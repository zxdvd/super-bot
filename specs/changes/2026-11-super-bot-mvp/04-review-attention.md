# 04 Review & Attention

职责：Worker 结构化报告、证据、验收、人工待办与低打扰通知。

## 报告与成果

只接受 progress / waiting / ready / blocked / failed。报告经真实作用域、run/revision/generation 和去重校验后入账；自然语言最后一句不补成 ready。晚到的过期报告只记审计。

ready 保存候选 Result 与版本化证据引用，执行收敛后才请求验收。Report 的 ready 不能释放仍占用的资源；新人工输入或证据变化使旧候选不再自动适用。

每项 acceptance 映射证据和判断；证据缺失/无法访问/哈希变化不能通过。Manager 的通过只是 Review；默认需用户针对确切 resultId 接受。模型不能填写 humanAcceptedAt。低风险自动验收必须由用户在任务授权中启用。

自动返工默认最多 2 次，按当前 taskRevision 持久计数；同版本重试、更换 Manager 或重启不得重置。扩大目标必须用户授权，不能为重置额度伪造新版本。额度耗尽或缺报告转人工事项；复杂验证可新建普通检查任务，不增加常驻 Reviewer。

## 待办与通知

- input：回答原子存 Input/Outbox，界面分别展示已提交、已投递、已进入上下文。对齐来源事实后解决；丢弃或未知则仍待核对。
- approval：引用 DSH 原生请求，状态以宿主为准；首版优先跳转原生审批，不做一个仅改账本的“批准”按钮。无法查到请求时展示能力限制。
- review：引用确切 Result 与 revision；接受/返工与 Task 迁移在同一事务完成。
- recovery：展示未知之处、可核对证据和允许的显式操作；不能仅点“继续”就跳过资源状态核验。

旧版本待办失效后禁止回复；输入先到达与后续业务处理分开记录。任务数量按 Task，待办数量按 Attention。通知只针对新待办、成果可用、明确失败；稳定事件 ID 去重，普通进展不持续唤醒 Manager。

验收：T05、T07、T10、T14、T18、T20。实现：SB-07、08、10、11。
