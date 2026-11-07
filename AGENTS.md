# Super Bot 工作约定

- 产品名 Super Bot，仓库 `super-bot`；当前交付 DSH 插件，未来载体不预先限定。
- 产品主线是“与 Bot 聊天 → Bot 自行安排执行 → 回到对话交付”；工作台是辅助入口。底层测试通过不能替代这一用户流程的验收，优先复用原生聊天与已有执行机制。
- 开始工作先读 README、ROADMAP 和活动 change 的 README、tasks、evidence；只勾选实际验证完成的任务。
- 领域与应用层不得 import DSH/Cordis/React；DSH 调用集中在适配层，Dashboard 通过应用命令/查询调用业务。
- 单进程与一个 SQLite 起步，不提前引入微服务、多引擎调度、通用 DAG 或自研 Agent Loop。
- 账本事务、幂等、版本、权限、资源占用是程序职责。Prompt 不能替代强制约束。
- 区分模型报告、运行事实、业务验收。turn/end、取消 accepted、Agent idle 都不能单独证明 Task 完成或外部效果停止。
- 不修改 DSH 安装包、上游源码或现有 `dsh-plugins`；兼容探针使用独立 profile/测试数据，不复用用户日常 Session。
- 密钥与实际聊天正文不入仓库。数据库、日志、证据产物放运行数据目录；仓库仅保留合成夹具、脱敏结果和稳定引用。
- 变更需有对应验收证据，尤其是重复投递、晚到事件、人工干预、停止与重启。实现阶段建立实际 build/typecheck/test 命令后同步 README。
- PR 在修复和本地验证完成后默认 Ready for review；只有工作确实未完成才用 draft。Spec 的 draft/ready 与 PR 状态是两个概念。
