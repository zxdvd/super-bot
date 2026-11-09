# Super Bot 首版：与 Bot 聊天，由它安排执行并交付

- Status: implementing
- Scope: repo（`repos/super-bot`）；workspace 项目索引仅作导航同步
- Complexity: standard（单仓库；复用既有执行，调整对话入口与交付）
- Context: super-bot
- Created: 2026-11-07
- Revised: 2026-11-09（同步 dogfooding 与交接状态；聊天主入口方向不变）

聊天入口与交付流程已有实现、确定性宿主测试及四轮真实 dogfooding；implementing 表示仍需完成产品体验核对和用户最终验收。既有 SB-00～14 的底层实现与证据保留，但不表示聊天产品已验收。当前成果、异常和剩余工作见[接手说明](../../../docs/handoff.md)。主要验证目标仍为 DSH Web `0.2.2-rc.1`，Desktop 后置。

## Why

用户要直接与长期存在的 Bot 聊天，把事情交给它，由它组织执行、跟进并回来交付。上一轮把任务账本和监督面板当成主要使用流程，要求用户理解任务、会话与执行步骤，偏离了这一目标。可靠底层继续复用，产品验收转向用户能否通过对话完成一件事。

## What

把 Bot 对话作为默认入口，任务和成果面板收为辅助“工作”入口。用户自然表达目标；Bot 直接回答普通问题，对需要执行的工作澄清必要信息、建立任务、派发并回到同一 Bot 对话交付。用户无需填写任务表单、复制 Session ID 或逐次点击开始。

先用一项专用目录内的本地文档工作验证完整体验。文件任务是本轮可验证执行范围，不把产品定位成文件管理器。明确不支持的工作由 Bot 说明限制，不伪装为已安排。具体流程、复用范围与边界以 [聊天主流程](06-chat-first.md) 为准。

## Non-Goals

不重写聊天引擎、消息存储或 Agent Loop，不增加通用对话路由平台、规划器、事件总线或数据库。复用 DSH 原生聊天、模型选择和审批；不承诺未经验证的内嵌组件接口。

独立 App/Web、第二执行引擎、多用户、通用 DAG、外部订阅、自动长期记忆、通用子 Agent 编排和 Desktop 兼容仍后置。用户于本轮明确授权 Bot/Worker Full Access，用真实模型修复自身；此项覆盖早先“仅文件工具”的范围限制。暂停新增面板分类与设置功能。现有权限、证据、停止和恢复约束保持有效。

## Acceptance Criteria

聊天体验以 C01～C06 为新的产品验收门槛；T01～T20 继续作为底层回归约束，见 [验收矩阵](requirements.md)。

- 用户选中 Bot 后进入可输入的聊天；一次性模型配置之外，不需要先进入任务工作台或启用“Manager”。
- 普通问答不创建任务。明确工作请求由 Bot 安排，模糊请求先澄清，不要求用户提供程序字段。
- 执行结束后，Bot 在同一对话给出结果摘要、可打开的成果和真实验证情况；默认明确“待你确认”，不能只让用户去任务列表寻找结果。
- 用户在对话中回答问题、提出返工；对象不明确时先澄清。人工最终接受必须由用户实际确认，模型不能代替用户写入验收。
- 最小演示必须由一句自然语言请求贯穿到交付，不能用 API 脚本预建任务或管理员代操作替代；真实模型验证与确定性测试分别记录。

- 一项任务能创建、派发到普通 Session、提交可核对成果、返工并被用户验收；Manager 自动验收仅对创建时明确授权的低风险任务开放。
- 两个 Bot 的任务与工具授权不串用；管理 Session 替换后能从账本继续管理。
- 重复命令、过期报告、目标修改、取消及重启不产生第二份责任，不伪造成功；无法确认执行效果时展示待核对并保留冲突资源。
- 面板与模型走同一应用服务；模型不可用时查询和确定性控制仍可用；100 个模拟任务的过滤、计数和分页一致。
- 运行核心测试不需要安装 DSH；真实适配测试与宿主 UI 验收单独记录版本和证据。

## Design Summary

继续使用现有 TypeScript 核心、SQLite/Outbox、Manager、Worker 与 DSH 适配。优先修改 Bot 入口、管理对话行为、重要事件的对话交付，以及必要的回答/返工工具；现有 Dashboard 保留为查看事实、异常处理和确定性控制的辅助入口。

关键补充：输入已入队与已消费分开；取消前阻止新派发并处理插件自有待处理输入；Failed Run 的终态不自动释放未知资源；证据绑定版本且验收时重新核对；Manager 提交必须验证当前控制模式。

## Links

- [任务与依赖](tasks.md)
- [聊天主流程与复用方案](06-chat-first.md)
- [验收矩阵](requirements.md)
- [00 架构与共同约束](00-architecture.md)
- [01 Bot Workspace](01-bot-workspace.md)
- [02 Task Ledger](02-task-ledger.md)
- [03 Session Execution](03-session-execution.md)
- [04 Review & Attention](04-review-attention.md)
- [05 Dashboard](05-dashboard.md)
- [研究证据及兼容门槛](evidence.md)
- [原始设计基线](../../../docs/design-baseline.md)


## 用户授权的 dogfooding 增量

用户要求直接使用自己的 web profile，Bot 为 zyq-codex/gpt-6.1-sol medium，Worker 为同模型 xhigh；两者 Full Access。先补最小宿主配置与 Shell/测试/Git 能力，再通过真实 Bot 对话委派此前审查问题，跟踪异常、验收改动并迭代。保留旧 files 模式用于隔离契约测试；full 模式明确为可信本机代码工作，不宣称文件目录仍是安全沙箱。项目目录作为资源占用根，防止多个 Worker 同时修改同一仓库。结果依然需要真实文件和检查证据，Full Access 不代表模型可伪造人工验收。

首轮由外层助手完成启动必需的能力修改；功能修复交给产品内 Bot/Worker，外层检查 diff、测试、交付并记录必要介入。运行日志/模型对话不入仓库；只保存脱敏证据。执行中不升级正在使用的插件或重启宿主；待任务收敛后发布新包继续试用。

## 第三轮真实使用增量（2026-11-08）

用户要求继续由产品 Bot/Worker 自己 dogfooding，授权安装配置指定的 dsh-plugins 搜索插件到现有 web profile；此项覆盖早先仅针对修复任务的禁止更改宿主配置约束，不扩大到其他配置/凭证。任务工作页应简洁清晰，并在 Bot 聊天附近方便切换或展示。先复用 DSH 已公开的会话 UI 插槽与工作面板，不重做聊天、不增加服务或数据库。正常视图突出当前工作、需要用户处理和成果；详细技术审计/配置按需展开。

通过真实聊天发起、补充需求、交付、用户反馈返工再交付；外层助手代用户执行本轮试用输入并核对实际运行和界面。最终真实用户接受仍后置，不冒充验收。执行中的自身插件不热替换，待收敛再加载。发现具体失败后最小修复并复验。

本机 DSH Web rc.1 已提供 `conversation.session.header.actions`、`sidebarRightTabs.register`、`sidebar.right.pane.tab` 和 `sidebarRight.openTab`。DF-06 优先在 Bot 会话顶部提供“工作”入口，宽屏复用原生右侧页，窄屏保留清楚的完整工作视图与返回聊天动作；依据当前原生 Session 映射到 Bot，不用浏览器中最后选中的 Bot 猜归属。只复用已有 task/detail/控制接口，必要时补一个只读会话归属查询。默认展示当前工作、需处理状态和成果，长任务说明/验证记录及管理配置折叠；不以隐藏内容取消原控制能力。

## 第四轮侧栏整理（2026-11-08）

用户确认先改善命名、主聊天置顶和历史整理，并继续由真实产品 Bot/Worker dogfooding。Workspace 使用稳定项目名，Worker 使用短任务名；避免 Untitled 和第一项长任务标题污染整个项目分组。原生归档会影响执行，因此不能为了隐藏而归档仍可能恢复/返工的会话；归属、用户已有命名/置顶和活动状态必须核实。保留完整普通 Worker，优先原生能力，无新侧栏或存储系统。

## 默认权限与 CLI 委派修复（2026-11-09，Bot 工具策略已由下文覆盖）

用户报告未配 fullAccess 时 Bot 因自身没有 Shell 而要求开启工具通道。改为 Worker 默认使用原生 Full Access；仅显式 `fullAccess: false` 保留旧 files 隔离/兼容行为，覆盖 DF-01 旧默认。Bot 不再直接使用原生执行工具，所有本机命令、外部 CLI/工具请求均通过账本建 Task 并派 Worker；成果预览继续走 detail。程序用工具列表和执行守卫强制角色边界，提示词负责识别工作意图与说明实际模式。files 模式明确说明 Worker 完整权限未开启和当前 profile 的 `config.fullAccess: true` 开启方法。Desktop 真实体验及真实飞书账号查询仍未复验。

## 仅补交付通知循环修复（2026-11-09）

针对仅交付通知 entered 无条件翻回 pending 导致重复唤醒，复用现有 outbox 的 attempts 与 payload，持久化最多 3 次补交付及 30/60 秒退避。只在真实输入所在轮次持久化结束后重排；到限 unknown 并只记录一次问题，不重跑 Worker。历史 pending 通知先核对，不因升级增加一轮尝试。交付检测按路径与成果/任务 ID 核对有效链接，不依赖完整 origin；保留最终回复、成功 turn/end、持久化及版本约束。Desktop 动态端口已经静态确认，另一台机器的真实账本未读取；证据与未验证范围见 evidence。

## 用户批准：Bot 原生查询工具（2026-11-09）

在 c80f28d 之后修改 e8e967b 的 Manager 管理工具独占策略。默认/true 时开放 skill、bash、read、read_image、job_output、job_list、job_kill，加已有 super_bot_manage；不给 write/edit 或原生 Worker/subagent。轻量只读查询、lark-cli 查询和 Shell skill 直接在 Bot 执行；修改、多步骤和长任务仍由 Task/Worker 承担，Worker 默认 Full Access 不变。显式 false 同时关闭 Bot 七项原生工具并保留 files Worker，提示具体 config.fullAccess 开启方法。

程序强制白名单、撤权、仅补交付作用域与 noWait：Bash 显式最多 30 秒或后台返回，拒绝常见 sleep；job_output 显式等待最多 5 秒，不等原生默认 30 秒。后台事件由宿主通知，不增加 Agent Loop 或通用路由框架。命令只读/修改的语义由指令分工，Shell 不是只读沙箱。保留上一提交的补交付上限、退避及持久化门槛。确定性聊天验证与真实模型/桌面验收分开记录。
