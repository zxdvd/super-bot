# Manager 通知可靠性（2026-11-16，北京时间）

起点 `675cf4a`，直接在开发 Mac 修改；不部署/重启公司生产、不修改其账本、配置或旧 unknown。没有 P3 UI 或外部消息渠道工作。

## 状态与门槛

- enqueueManager 无论管理会话是否已启用/ready，先事务持久保存原通知；确认 Manager 时不为已有 pending/sending/entered/unknown/blocked 再造 backlog。未配置管理会话不自动创建，已禁用/旧配置会话不唤醒。
- pending（安全、尚未入队的机会）：未选模型/会话忙碌每 30 秒检查；唤醒额度不足等待当前窗口最早额度过期。这些门槛不增加 outbox.attempts、不调用模型。真正入队前的服务错误指数退避，最多 5 次，之后 blocked，需显式人工处理；重启不清零次数/期限。
- 任务暂停/人工接管时，created/revision/capacity 等调度通知保留不自动唤醒；原有状态/审批/失败/成果交付提醒仍可呈现，不恢复任务派发/审查权限。Manager 不启用或被释放时，两类都不唤醒。
- claim 在调用原生 followup **之前**原子保存 messageId/messageJson 并增加尝试次数。之后的 throw、崩溃或回执不明统一按可能已入队处理，绝不当作入队前失败重新发送。unknown/handled/superseded/blocked 的旧自动排队项在 Agent 恢复/idle 附加权限时精确隔离，不动人工或其他通知输入。
- unknown / legacy entered：恢复只读持久日志，不 resolveAgent，不从空 Inbox/Job 列表推断完成。仅精确 messageId + botId + managerId + eventId、连续持久事件、不跨轮的最终可见自然停止回复 + completed end 才闭合为 done。错误、重复输入、错来源、断序、缺 end 都不补成功。只读核对最多 3 次（30/60 秒退避），每批最多 10 条、共用一次日志读取；达到上限转/保留 unknown，显示核对说明，不再自动读取或唤醒。
- 原生日志读取限制为 100000 事件；可得元数据超过 32 MiB 时也拒绝自动核对。请求给后端 5 秒取消信号；后端需配合取消，不把超时当完成证明。实时 turn/end 兼容核对最多处理最近 50 条通知。新持久的原生结束事件仍可提供新证据，不通过定时器无限重试。
- 一般管理通知可能执行过工具，缺回复时不重跑。**仅补交付**继续沿用原有最多 3 次唤醒、30/60 秒退避：只有本次输入所属轮次持久结束且未发现有效交付，才允许下一次只读/交付尝试；不重审、不派 Worker、不接受成果。显式 deliver 的事务回执及原有链接识别兼容逻辑保留。
- 自动管理轮次结束时解除其自己的超时；whenIdle 跟随人工下一轮也不允许旧定时器取消人工输入。未改 Full Access 权限、原有审查/自动返工上限或人类验收边界。

## 诊断与人工处理（无新 UI）

宿主认证的 `manager.status` 返回 notifications（最多 20 条未完成记录）：id、state、attempts、deferReason、nextAttemptAt、reconcileAttempts、reconcileNote。人工先核对原生会话、工具效果与交付，不以 unknown 当作“未发送”。

只有 owner 的现有 `/api/super-bot` RPC 增加 `manager.notification.resolve`；不加入模型的 super_bot_manage 工具 action。沿用标准 client-request envelope，payload 例如：

```json
{"action":"manager.notification.resolve","requestId":"operator-unique-id","botId":"BOT_ID","eventId":"NOTIFICATION_ID","resolution":"handled","acknowledged":true}
```

- handled：仅 unknown/blocked，明确记录“人已核对处理”，不伪造聊天交付、成果完成或验收，不执行/重发消息。相同 requestId 幂等，审计 actor=user；只清除此通知自己的问题提示，并精确移除已加载 Agent 中旧通知的待处理项；不加载会话、不取消已运行轮次。恢复时也隔离已 handled/旧 Manager superseded 的自动项，防止后来人工发言意外唤醒旧通知。
- retry-unsent：只允许 blocked、attempts=0 且没有任何 messageId 的未入队通知，明确确认后重置入队前失败预算/期限；不重置已发生的唤醒/补交付计数。任何可能入队的旧消息都拒绝走此路径；请人工对话处理或 handled，不能用此 API 盲目重发。
- 不提供“unknown 一键重发”。没有证据的安全收敛就是保留人工决定，不牺牲 at-most-once 去追求自动成功。

## 兼容性与边界

保持 schema 9；只扩展既有 outbox payload / 状态与只读诊断，没有删除/改写历史责任。旧 pending/sending/entered/unknown 按原规则保守归类，再进入有预算的证据核对；缺稳定身份不造证明，也无法安全猜测删除其 Inbox 项，须先人工检查旧会话队列再继续该会话；旧 pending 只要有任何 attempts/messageId 入队迹象、又无可验证的仅补交付结束回执，进入 entered/unknown 的证据核对，不能当“没发过”。旧版当初因未启用 Manager 已经丢弃的通知无法凭空重建，确认会话时仅保留既有有限 backlog 恢复。不要混跑两个版本/宿主；旧版本不理解新增 blocked/handled 和等待元数据，不建议以降级来绕过核对。

不承诺外部系统 exactly-once、用户已读、未跟踪 detached 进程或真实模型质量；显式 deliver 表示插件事务交付回执，不证明人已阅读。未做跨通知合并、聊天 UI、通知渠道接入或复杂通用 Effects 框架。普通 unknown 即使 native end 已结束但无可确认回复，也不会重执行工具。

## 验证

`npm run check`：87 单元 + 179 适配测试，共 266，含 types、行长、build。增加 19 项通知回归，涵盖持久预就绪、错误预算、小时上限、unknown 完整/缺失/错 ID/错来源/重复/跨轮/断序/漏回复、禁用、暂停、超时续轮、旧 entered 读失败、超大日志、批次边界、legacy pending 入队迹象及 handled/旧会话潜伏输入；保留既有 3 次补交付/显式 deliver 测试。

`npm run smoke:notifications` 与 `SUPER_BOT_TEST_FULL_ACCESS=true npm run smoke:notifications` 均自建 `.runtime/reliability-notify-*` 下的独立 HOME、DSH_HOME、profile、账本、工作目录及无网络提供方，端口随机。真实 Manager adapter、Agent Inbox/driver、原生工具边界与持久化参与；无真实模型凭证或费用，只停止自己启动的子进程。

| 隔离真实宿主场景 | 观察 |
| --- | --- |
| 未启用→重启→创建中/未选模型→ready | 原通知 pending、attempts 0、模型 0；ready 后恰好 1 输入/1 模型调用→done |
| 小时额度已用完→额度过期 | 第二条 pending、attempts 0，无新模型；过期后总计 2 输入/2 调用，各一次 |
| Manager disabled | pending 保留，attempts 0，模型 0，不自动重新启用 |
| 自然回复/end 持久化、账本回执前 SIGKILL | 崩溃前 entered、1 输入/1 调用；两次重启只读补 done，messageId 不变，每次重启模型 0/新增输入 0 |
| 原生 Inbox 已接受、entered 前 SIGKILL | unknown、attempts 1；两次重启不重发，移除精确自动项但保留人工项；持久核对到 3 次后再重启读取/模型均 0 |

宿主的额度过期与退避测试只推进**专用测试账本**的调度时间（不重置预算/消息身份）；真实时间边界另有 mock Date 测试，不声称实际等了一小时。Worker 原可靠性矩阵（两模式各 8 场景 + 6 崩溃窗口、每窗口恢复两次）也回归。原始 host.log 含本机启动 token，勿外传。

最终证据（仅开发机，原始日志不外传）：
- Manager files：`.runtime/reliability-notify-tCZtdS/`；Full Access：`.runtime/reliability-notify-RWeIXY/`。
- 原产品 owner RPC + Worker 全矩阵：`.runtime/reliability-xxhx2Y/`（files）、`.runtime/reliability-lRpSvO/`（Full Access）。真实 owner RPC 对 unknown 拒绝 retry-unsent、拒绝未确认 handled；确认 handled 及重复同 requestId 均无新增输入/模型调用，任务 rowVersion、Run、Result 不变（claimed 1，entered 0，模型 0，uncertain 1→0）。
