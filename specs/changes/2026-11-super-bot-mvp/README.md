# Super Bot 首版：持久管理者与任务监督闭环

- Status: implementing
- Scope: repo（`repos/super-bot`）；workspace 项目索引仅作导航同步
- Complexity: standard（单仓库、多模块、恢复语义复杂）
- Context: super-bot
- Created: 2026-11-07

已完成提案 review，开始实现。P0 是启用自动执行的技术门槛；若必要能力不成立，先记录降级或更新提案，不继续假设完整支持。当前没有等待用户回答的产品范围问题。主要验证目标为本机 Web `0.2.2-rc.1`，Desktop `0.2.1-rc.5` 留作后续兼容检查，不混用两套 API。

## Why

普通长聊天无法持续承担跨任务工作索引、成果验收和人工待办。用户需要几个长期负责不同领域的 Bot，在原生任务对话之外获得可信的监督入口。

## What

新建独立 Super Bot 产品，首版为 DSH 插件。一个数据库、一个宿主、五个业务模块；先完成一个 Bot 的端到端流程，再验证多个 Bot。领域和应用契约保持载体独立，DSH 承担实际执行与原生交互。

首版包含：任务目标/授权/验收、Session 关联、尝试与输入追踪、证据与版本、有限返工、人工待办、控制操作、任务面板、重启核对。事务与去重从第一条执行路径存在。

## Non-Goals

不实现独立 App/Web 宿主、第二执行引擎、多机/多用户、通用 DAG、自动项目排期、外部 IM/GitHub 订阅、自动长期记忆、自动发布或合并。任务完成与发布/合并/消息外发分别处理。首版不构建隔离沙箱；Bot 与 worktree 不是安全租户。

## Acceptance Criteria

验收编号 T01～T14 继承原基线；T15～T20 补充本轮发现的缺口，见 [验收矩阵](requirements.md)。

- 一项任务能创建、派发到普通 Session、提交可核对成果、返工并被用户验收；Manager 自动验收仅对创建时明确授权的低风险任务开放。
- 两个 Bot 的任务与工具授权不串用；管理 Session 替换后能从账本继续管理。
- 重复命令、过期报告、目标修改、取消及重启不产生第二份责任，不伪造成功；无法确认执行效果时展示待核对并保留冲突资源。
- 面板与模型走同一应用服务；模型不可用时查询和确定性控制仍可用；100 个模拟任务的过滤、计数和分页一致。
- 运行核心测试不需要安装 DSH；真实适配测试与宿主 UI 验收单独记录版本和证据。

## Design Summary

采用 TypeScript 领域/应用核心、SQLite 存储、React Dashboard（建议技术栈，工具版本在 SB-01 固定）。DSH Host/Client 负责装配，不把宿主类型带入核心。只定义当前需要的执行与导航边界，不实现通用运行时平台。

关键补充：输入已入队与已消费分开；取消前阻止新派发并处理插件自有待处理输入；Failed Run 的终态不自动释放未知资源；证据绑定版本且验收时重新核对；Manager 提交必须验证当前控制模式。

## Links

- [任务与依赖](tasks.md)
- [验收矩阵](requirements.md)
- [00 架构与共同约束](00-architecture.md)
- [01 Bot Workspace](01-bot-workspace.md)
- [02 Task Ledger](02-task-ledger.md)
- [03 Session Execution](03-session-execution.md)
- [04 Review & Attention](04-review-attention.md)
- [05 Dashboard](05-dashboard.md)
- [研究证据及兼容门槛](evidence.md)
- [原始设计基线](../../../docs/design-baseline.md)
