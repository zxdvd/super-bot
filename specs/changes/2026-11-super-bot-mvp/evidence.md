# 研究证据与兼容验证

研究日期：2026-11-07。本页区分原始输入、上游源码线索、本机静态检查、实际实验。插件加载与工作台已完成真实宿主试用；任务执行端到端仍未完成。早期静态记录保留，最新结果见文末。

## 结论

1. 新建独立 `super-bot` 产品仓库，当前做 DSH 插件；原搜索插件仓库不承担本产品。用户已确认目录与未来 App/Web 可能性。
2. DSH 提供普通 Root Session、持久事件、Agent inbox、作用域工具和客户端扩展的线索，适合先做 P0；引用这些 API 不等于已验证组合行为。
3. 本机版本为 `0.2.1-rc.5`，不能沿用 `dsh-plugins` 2026-11-01 的 rc.3 验证记录。
4. 本机取消方法保留 Inbox；投递回执、输入消费、整棵执行树停止是不同事实。未知事实必须保守地保留资源并转恢复核对。
5. 内置 Node 的内存 SQLite 可用，尚未验证真实插件中 WAL、文件锁、迁移/备份和异常退出。

## 已读取的一手资料

| 来源 | 本次观察 | 用途与限制 |
| --- | --- | --- |
| [DSH 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md) | 持久 session/event 与实时 agent/* 分开；原生运行时以插件组成 | 事件来源和 Adapter 边界；master 可变，不能代替版本固定 |
| [DSH 核心契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.zh.md) | send/followup、持久 inbox、whenIdle、cancel；claimed 不等于进入模型上下文 | 消息追踪/停止探针设计；需与本机 rc.5 对照 |
| [DSH 工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.zh.md) | 工具注册/限制与执行上下文有明确作用域机制 | Manager/Worker 权限设计；对子 Agent 的继承必须单独测试 |
| [DSH 打包](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) | bundle/profile 分离、engines.dsh、共享 peer/dev 依赖、已构建 tarball 安装 | 独立产品仍可作为插件分发；不能拿 alpha 依赖直接配 rc.5 |
| [DS-Bot agents.js](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/src/host/agents.js) | 通过 sessionController.create 创建普通 Session，支持显式关联与打开的管理逻辑 | 它的 DSH Agent 入口与 Bot 团队分开；不是“每 Bot 管任意 Task”的现成实现；main 可变 |
| [SuperAgent execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md) | Ticket/Assignment、持久输入、等待/重试/恢复、容量和重要消息机制 | 借鉴行为；它的自动恢复/结束规则不直接作为 Super Bot 完成语义 |
| [SuperAgent package](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json) | bundle + client 入口；声明 DSH alpha.2 开发依赖 | 结构参考；本机 rc.5 需要独立兼容测试 |
| [SuperAgent client](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/index.tsx) | main/sidebar slots；uiWorkspace.openSession；挂载/卸载导航生命周期 | Dashboard 宿主接入的具体线索；不复制其产品流程 |

Grok 等来源保留在用户设计快照，本轮没有重新核查其产品资料，不将其性能或内部实现当作事实。本轮对可变上游分支的阅读是方向性证据；SB-01/02 必须固定实际安装依赖/产物，不能宣称支持任意最新版本。

## 本机静态检查与实验

未启动日常 Desktop 会话、未读取个人聊天或凭证；只用 Electron Node 模式读取安装包和执行内存 SQLite 探针。

入口：`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`，环境 `ELECTRON_RUN_AS_NODE=1`。

| 检查对象 | 结果 | 证据等级 |
| --- | --- | --- |
| Resources/app.asar/package.json | @deepseek-ai/dsh-desktop 0.2.1-rc.5 | 本机安装元数据 |
| dsh-api-session-controller / dsh-agent / dsh-session package.json | 均为 0.2.1-rc.5 | 本机安装元数据 |
| runtime/versions.json 与 process.versions.node | Node 24.21.0；manifest pnpm 11.28.5 | 本机检查，不等于开发工具版本已选定 |
| require('node:sqlite')，DatabaseSync(':memory:') | 建表成功；sqlite_version() = 3.53.4；已关闭连接 | 实际内存探针通过 |
| dsh-api-session-controller/lib/index.js，约 756 行 | create 支持 Workspace 或 cwd，内部普通 Session 创建 | 静态源码，不是 API 调用通过 |
| 同文件 925～950 行与 1128～1138 行 | prompt 经 resolveAgent；按 source.rpcId 查 inbox 与 user/message；再 followup/steer | 静态源码；不能据此证明全部故障窗口幂等 |
| 同文件 1061～1066 行 | cancel 调 agent.cancel({kind:'user'}, {keepInbox:true})，返回 accepted | 静态源码；明确只代表请求已接受 |
| dsh-jobs/lib/index.js | 存在按 owner Session 查询 running/stopping 作业、相关停止处理 | 静态线索；整棵子执行树与远端效果仍待验证 |

上述 controller 产物 SHA-256：`a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386`。安装更新后行号可能变化，应先核对版本和哈希。

可复现的无外部效果探针（仅内存数据库）：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE probe(id TEXT PRIMARY KEY)"); console.log(process.versions.node,db.prepare("SELECT sqlite_version() AS version").get()); db.close()'
```

这次没有修改安装包或 profile。应用包的 package.json 指向 d.ts，但读取的发行包 types 目录实际包含 .js；后续类型检查应使用匹配发布版本的开发依赖，不从安装产物推断完整 TypeScript 接口。

## P0 初始能力表（更新结果见文末）

| 能力 | 当前证据 | 验证入口/故障样例 | 不成立时 |
| --- | --- | --- | --- |
| Host/Client 加载与卸载 | 官方文档+参考插件 | SB-01 隔离 profile 安装、重载、禁用 | 不能进入实现派发阶段 |
| 普通 Session 创建/解析/导航 | 本机 create、参考 UI | SB-01/05 创建后重启、创建回执丢失 | 待核对；不盲目新建 |
| 输入 ID 持久关联/去重 | 本机 prompt 与官方 inbox 文档 | SB-02 准备阶段取消、回执丢失、重启 | 无证据不重投、不标已读 |
| 原生人工输入识别与顺序 | 官方 source/事件线索 | SB-02/09 与派发并发 | 显式接管，UI 标明限制 |
| tools/jobs/subagents 收敛 | 本机 cancel/jobs 与 Agent 文档 | SB-02 后台工具仍在、取消超时 | 请求停止/待核对，保留资源 |
| 原生审批查询/跳转 | 发行包含 approval UI；接口未验证 | SB-02/08 请求、拒绝、失效 | 跳转原生 Session；不伪造聚合审批 |
| 工具作用域/子 Agent 继承 | 官方工具契约 | SB-02 普通 Session、另一 Bot、子 Agent 尝试越界 | 无可靠强制边界则不开放自动管理 |
| 本地持久 SQLite/独占控制 | 内存 SQL 通过 | SB-01/03 WAL、双宿主、崩溃、重载 | 选兼容驱动或阻止调度，不能退回不可靠 JSON |
| 部分历史授权 | 设计要求，未证实宿主支持 | SB-05 检查真正进入模型的历史 | 全历史明确授权，或新建 Session 导入选定材料 |

## 实现后填写

每个 SB 任务记录：提交/包版本、场景、命令或 UI 操作、实际结果、证据位置、剩余限制。不得只写“测试通过”；Fake 与真实宿主结果分列。T01～T20 的最新子场景覆盖与残余缺口见 requirements.md；下方保留各阶段历史证据。

## 提案 review 与执行决策（2026-11-07 01:45）

- 无阻塞产品决策；开始 spec-apply。用户要求避免过度设计，采用单包/少量模块/直接业务方法；保留事务、幂等、版本和真实停止语义。
- 原任务依赖使不执行模型的工作台也必须等全部 P0 探针，过重；改为 SB-01 后实现账本和面板，自动派发仍受 SB-02 必要验证门槛约束。
- 本机 Web PID 对应 npm CLI `0.2.2-rc.1`，监听 127.0.0.1:3080；Desktop 为 rc.5。首版固定 Web rc.1，并另启测试 home/profile，不修改日常实例。
- 用户要求持续开发至本地 07:00，版本可用后由独立 subagent 试用、反馈，再修复复验；不靠重复无变化检查消耗时间。

## 本次规划交付检查

- 本地仓库已初始化为 `main`，没有远端、提交或产品实现代码。
- 15 份 Markdown 的相对链接、围栏、空白和冲突标记检查通过；任务编号 17 项（含已完成准备 SB-00、15 项后续开发任务和 FV），验收编号 T01～T20 完整。
- Personal Docs 索引检查通过：92 个 README、600 份 Markdown、18 份 HTML；`git diff --check` 通过。仅在 projects.md 增加 Super Bot 条目，保留原有未提交变更。
- 本轮没有运行产品 build/test 或真实 DSH 任务；下一步使用 spec-apply 从 SB-01 开始。


## Web 开发预览与契约探针（2026-11-07 02:28）

目标：DSH Web `0.2.2-rc.1`、Node `24.21.0`、SQLite `3.53.4`。使用仓库 `.runtime/dsh` 和 `super-bot-test` profile、端口 3081；日常 3080 与 Desktop 未修改。依赖版本及完整 integrity 位于 package-lock.json。

- `fnm exec --using=24.21.0 npm run check`：7 项测试全部通过，类型检查、Host/Client 构建通过。覆盖文件重开/WAL、未知新 schema 拒绝、同请求幂等与异内容冲突、注入审计失败的完整回滚、版本冲突、100 任务计数与分页、数据库独占与关闭释放。
- `npm run smoke`：真实 Host 返回 runtime/SQLite/WAL；无认证请求 401，跨域已认证请求 403。认证链接及 cookies 不写入结果。
- `npm pack --dry-run --json`：仅 README、manifest、bundle patch、Host/Client JS 与 sourcemap，7 个文件；无数据库、日志、凭证、测试插件。
- 独立 trial agent 共 4 轮 UI 使用：Bot A/B 与任务不串用；创建完整/不完整任务、补全、暂停/恢复、搜索、重载持久化通过。修复并复验筛选残留旧详情、计数标签误导、旧探针 Session 未归属 Workspace。原生 Session 输入已可编辑，未调用真实模型。
- 新发现的纯空格表单错误已改为表单内校验，待下轮 UI 复验。分页后清空详情代码已完成，浏览器仍需超过 25 条数据的回归。

确定性测试插件源码在 `test/host-probe.ts`，单独构建为 `.runtime/probe-plugin`，不随产品打包。命令：`node scripts/build-probe.mjs`；通过官方 `dsh plugin --profile super-bot-test add <绝对路径>/.runtime/probe-plugin` 安装后，`node scripts/probe.mjs` 调用真实 Host。输出保存在 `.runtime/dsh/super-bot/contract-probe-result.json`，仅合成数据。

| 探针 | 结果 | 产品语义 |
| --- | --- | --- |
| 入队但未唤醒 | supported：Inbox 可见，user/message 不存在 | 不能标为已消费 |
| 普通输入完整 loop | supported：message id/source 贯穿 Inbox、Session log、模型请求 | source 采用插件自有 kind，不假扮原生用户 |
| Worker 报告工具 | supported：真实工具上下文的 Agent ID 与绑定一致 | 执行身份从宿主读取 |
| 另一个 Session 伪造同名调用 | supported：schema 不可见、工具结果拒绝、执行函数未调用 | when 条件同时约束声明和 dispatch |
| pre-step 已 claim 后取消 | **limited**：keepInbox=true 仍不恢复已 claim 的普通输入，且没有 user/message | 无法由“队列里消失”推断已读；必须恢复核对 |
| 定向撤回 pending 输入 | supported：仅删除指定 MessageId，保留其他输入 | 不清空用户收件箱 |

准备阶段取消的测试先失败，反查真实行为后固定为上表契约，不修改上游。后台 job、子 Agent 收敛、原生审批、插件热重载、真实模型成果尚未验证；SB-02 不勾选完成。SB-03 的纯账本交付已验证，执行 Outbox 将随 SB-06 使用。


## 文件执行闭环与停止（2026-11-07 03:05）

- 新增持久 Binding / Run / Input / Result / Review；schema 当前 5。Session 创建意图及投递 Outbox 在外部调用前落账；请求回执查询先于运行忙闲检查，重复请求返回同一 Run。
- `npm run check`：18 项核心测试通过，包含候选与验收分离、资源容量/目录重叠、停止收敛前保留资源、原生介入永久终止旧 Run 授权、回答未进入上下文前不关闭问题、取消回答重新开放问题、返工不修改目标版本、文件哈希及目录 symlink 检查。
- `node scripts/probe.mjs`：新增真实子 Agent 越权拒绝、作业 running→停止请求→stopping→生产者确认 killed；Agent idle 期间作业仍 running。Session 创建成功但丢弃回执、关闭重开账本后，按预分配 ID 找回同一 Session。探针未启动实际 shell 进程。
- `npm run smoke:execution`：真实 DSH 的 write/read/super_bot_report 三步生成 132 字节合成文件，输入 entered、Run settled、Task review；修改文件后验收拒绝，恢复后同一成果接受一次。重复派发/验收无重复对象。延迟测试模型 STOP_PROBE 被停止后 Run cancelled、Task paused，未误标完成。
- `npm run smoke:workflow`：ASK_PROBE 提问→保存一次回答→下一 Run 消费原回答 Input→问题 resolved→ready→人工拒绝并保存返工 Input→新 Run/新 Result→文件增加修订文字→接受；taskRevision 始终 1。
- 独立试用第 5 轮验证两个任务使用不同目录/会话；第 6 轮仅经 UI 完成模型选择、执行、检查原生 diff、接受、重载。发现并修复完成后控制按钮未禁用、筛选列表移除后残留详情。

当前 Worker 阶段只放行专用目录 read/write/edit 与报告工具；Shell/子 Agent 尚未开放。真实模型、外部副作用、完整原生审批和故障注入仍待验证。后台作业探针证明了查询/停止契约，不宣称任意外部进程已可可靠停止。Manager 尚未接入。

独立试用第 7 轮：UI 完成回答/返工/接受，原生文件 132→176 字节且新增修订说明；STOP_PROBE 原生显示 Stopped，面板暂停且未完成；完成按钮与筛选详情修复复验通过，无 console error/warn。


## 持久 Manager 与百项工作台（2026-11-07 03:49）

- schema 6 新增 Manager 绑定历史；管理事件复用 Outbox，发送前持久化消息身份，重启后未知发送不重放。重要事件自动唤醒，progress 不入队。Manager 的所有业务工具调用按真实 Agent 身份解析 Bot，不接受模型填写身份。
- `npm run check`：21 项核心测试通过。新增 Manager 创建/事件 claim、跨 Bot Review 拒绝、默认人验收保持 review、显式授权自动完成且 humanAcceptedAt 为 null、自动返工 2 次后暂停转人、管理会话替换立即撤销旧身份。
- `npm run smoke:manager`：真实宿主自动消费新任务事件→安排 Worker→读取实际文件→Review；human 保持待验收，bot 授权完成；普通问候不建任务，管理聊天创建任务；另一 Bot 的任务读取拒绝；替换管理会话后原账本工作仍在，旧会话 tools 为空且不能创建任务。
- 测试中发现 DSH 会发出无工具的辅助标题请求；探针改为按 `purpose` 区分 conversation 与辅助调用，不把辅助请求误判为 Manager 丢失工具。业务实现没有因此放宽工具权限。
- 独立试用第 8 轮：完全经 UI 验证普通问候、管理聊天建任务、默认人工验收、显式 Bot 验收；关闭面板后继续执行，原生 detail 输出包含实际文件全文。第 9 轮：更换管理会话保留原两项任务和旧会话；返回/刷新保持所选 Bot。
- `node scripts/seed-ui.mjs` 经产品 API 创建 100 条合成记录，不直接改库：90 未完成（50 待安排、30 暂停、10 缺条件）、5 待验收、5 完成。独立试用四页各 25 项，100 个唯一 ID，无重复遗漏；计数、搜索重置分页、各筛选和跨 Bot 切换均通过。

当前仍是文件工作预览，真实模型质量、完整原生审批、既有 Session 历史授权、Shell 外部进程、通知故障/迁移备份等未完成的验收不勾选。独立试用发现的分页范围提示属于后续小改进。

## 备份恢复、回执丢失与强制退出（2026-11-07 04:05）

- `npm run check`：22 项测试通过，新增运行中 SQLite 一致性备份、同请求并发去重、后续写入不改变快照、仅恢复到新目录、拒绝覆盖、原数据保留、恢复后暂停/待核对与不重放管理通知。schema 仍为 6，版本定义统一到 `schema-version.json`。
- 真实契约探针新增：实际 `agent.followup` 接受输入后人为抛出回执丢失；Run interrupted、占用保留、定向撤回自有输入并取消；重复 dispatch 返回同一 Run，没有二次 followup。修复此窗口过早释放工具限制的问题，现在保持到 Agent idle。
- `node scripts/smoke-restart.mjs prepare` 创建合成 STOP_PROBE，并等待输入 entered；仅对确认监听测试 3081 的进程 SIGKILL。重启后 `verify` 证明 Run/Input ID 未改变、任务 recovery、重复派发不重放、显式核对后保持 paused。日常 3080 未操作。
- 独立试用第 10 轮：备份路径与仅账本范围说明清楚；100 项四页范围与页码正确。断线保留详情快照、禁用变更；重连错误消失且状态未改变。宿主会自动切回原生会话，工作台选中位置丢失；已增加视图记忆，下一轮复验。
- 官方 CLI 卸载产品后重启：产品 API 404、账本锁释放，原 Bot 数据和原生 Session 保留；`super_bot_report` / `super_bot_manage` 不再注册。重新添加后工具各只有一份。
- `npm pack --pack-destination .runtime --json`：9 个文件，仅产品产物、README、schema 定义和恢复脚本；不含运行数据或测试插件。此阶段包 SHA-256 `8dc4c0386dbae47c346ab64d801e074402c5d4d4a33cc1e0471dc6337e13aed2`。重装后认证/跨域 smoke 再次通过。
- 面板备份恢复到新的 `.runtime/restored-lifecycle`，使用 `SUPER_BOT_DATA_DIR` 启动实际宿主；`node scripts/smoke-restored.mjs`：15 Bot / 128 Task 与备份一致，112 未完成任务暂停并待核对、管理 pending 事件为 0，27 个当前成果文件哈希一致、40 个会话可读取且 idle。随后停止副本宿主并切回原始账本。恢复没有复制 DSH/成果文件，本轮沿用隔离 home 和原成果目录。

运行中热卸载、真实模型质量及此前未覆盖的审批/历史授权仍未验证；上述结果不扩展为所有 T01～T20 已通过。

## 工作台恢复与任务控制（2026-11-07 04:10）

- 独立试用第 11 轮：切换原生会话、刷新重开与短暂停机重连后，Bot / 搜索 / 未完成筛选 / 第三页 / 选中任务均保留；跨 Bot 和筛选移除任务时清除旧详情。离线提示改为中文，写操作禁用，在线自动恢复。SB-04 的百项查询与离线验证完成。
- `npm run check`：25 项核心测试通过。增加取消保留历史/丢弃未发输入、运行中和未知资源占用时拒绝取消/解绑、解绑暂停并允许新目标版本/新代数；过期报告记录一次审计，重复过期报告不改当前成果。
- `node scripts/smoke-controls.mjs`：真实 Host 解除关联后原生会话保留，旧 prepare 请求不会重新关联；修改目标后 Session 和目录均更新，generation/taskRevision 为 2；取消待验收任务保留 Result 且 humanAcceptedAt 为 null；执行中取消/解绑拒绝，停止收敛后可取消。
- 独立第 12 轮 UI 通过：两步解绑、历史链接、修改目标版本 2、新目录/会话；取消待验收后成果保留且无接受按钮；STOP_PROBE 执行中禁用取消/解绑，停止后可取消。两项合成任务均已取消，无 console warn/error；已有 Session 的历史授权关联仍未实现。

## 原生审批（2026-11-07 04:18）

- 阅读目标安装包 `dsh-user-approval` / `dsh-client-ui-approval` 的 README、类型与实际事件契约，接入 asked/decided 审计。`npm run check`：26 项测试通过；审批结果不等同于 Run 收敛，跨 Session 决定无效，重启失效审批不重发。
- 独立第 13 轮使用无网络假模型的 `APPROVAL_PROBE`，由测试插件对一次真实 write 注入 ask。原生 UI 三分支均通过：Reject 后 failed/无成果；Allow once 后写入 132 字节、ready→人工待验收；等待审批时停止，原生审批撤回、write 在 dispatch 前 aborted、任务暂停。
- `node scripts/smoke-approvals.mjs c64d40a7-f06b-41fa-9758-cfd40f08f5df` 回读三任务：allowed-once / cancelled / rejected 均有持久事件，无 open approval；拒绝/停止时磁盘不存在 result.md；允许成果 humanAcceptedAt 为 null。
- 试用发现 DSH `workspace-changes` 把同期父 Git 工作树中的产品源码编辑列入原生 diff。目标包 README 明确此行为；模型实际 write 已被拒绝，未发生越界写入。测试夹具增加独立 Git 边界，产品不擅自初始化用户仓库。独立第 14 轮在等待审批期间同期修改 README/Spec/evidence，再 Allow once；原生变更列表与文件选择菜单均只有 result.md（+4/-0），不含父仓库源码/文档。审批事件中文准确显示仅允许本次、已拒绝、已撤回，无 console warn/error。

## 管理队列与自动返工（2026-11-07 04:25）

- `npm run check`：27 项测试通过。修复通知统计被 LIMIT 10 截断，测试 27 条待处理通知准确显示；增加轮转游标、用户回答/返工/恢复优先队列和可见的管理错误。管理通知 claim 与游标写入同事务；普通 progress 不唤醒。
- 真实契约探针共 11 项：新增三个真实 Manager Session 的故障对照，一个解析失败、一个 followup 接受后丢回执、一个正常。失败 Bot 不挡住后者；未知通知取消且同一通知不二次 followup，无 Worker 任务被重新执行。
- `node scripts/smoke-manager-rework.mjs`：一次自动返工产生两轮/新成果（176 字节）；无限返工夹具只产生三轮（最多两次返工）后暂停转人。更换 Manager 后显式恢复，仍不能重置同一目标版本的返工额度。
- 独立第 15 轮 UI：新 Bot 的两任务分别真实 2 turn/6 steps 与 3 turn/9 steps；原生 Manager 11 turn 中实际 detail 读取文件和 review: rework，工作台关闭期间继续，额度任务 rowVersion 12 保持稳定，无循环。百项夹具统计与分页抽查通过，无 console error。暂停验收任务的标签补为“待验收 · 已暂停”，并解释只暂停自动管理。


## 执行边界、证据上限与新版本视图（2026-11-07 04:42）

- `npm run check`：29 项核心测试通过。证据读取改为分块 SHA-256，单文件 10 MB/合计 20 MB，预览仅保留前 12,000 字节；尾部内容变化仍使哈希核对失败。文件缺失返回明确恢复提示。
- `node scripts/smoke-directory.mjs`：实际改变 DSH 有效目录会中断授权、保留恢复事项；目录不匹配时不能创建新 Run，恢复原目录后显式新 Run 可执行；相对文件路径在写入前拒绝。未修改上游。
- `node scripts/smoke-scoped-tools.mjs`：实际 agent-scoped 合成工具出现在模型工具列表，Worker/Manager 各尝试调用一次，但执行函数计数均为 0；Worker 仍完成正常文件任务。增加执行 guard 后不依赖全局工具列表的筛选能力。
- `node scripts/smoke-manager-rework.mjs`：复验一次返工/两次额度/更换 Manager 不重置额度，并新增大文件：即使显式 Bot 验收授权，截断预览也只能转人工，不能自动完成。
- 独立第 16 轮 UI：缺条件任务不派发，补全后新目标版本自动唤醒 Manager 并执行；解绑/新代数不展示旧成果为当前候选，旧会话和文件保留；暂停验收标签通过。发现旧输入标题易误读，已改为历史输入，待第 17 轮复验。

独立第 17 轮 UI 复验通过：16,133 字节成果在 Bot 授权下仍待人工验收，原生 detail 确认 `truncated:true`；新会话显示历史输入、无旧候选；Worker/Manager 额外工具真实拒绝后正常管理/文件流程可继续。console warn/error 为空。列表与详情进一步优先显示“本次需人工验收”，保留原任务授权不变。


## 执行预算（2026-11-07 04:46）

- Worker 增加每 Run 40 步上限，跨 turn 不重置；保留原 10 分钟截止。先记录预算原因并停止，确认收敛后才释放资源；转人工核对且保持暂停，不自动重试。
- `npm run check` 在预算改动后 30 项核心测试通过；真实 `node scripts/smoke-budget.mjs steps` 模型调用恰好 40 次，Run cancelled、原生 idle/空 inbox、无候选，明确核对后仍 paused。
- 独立第 18 轮 UI 自建任务复验：原生 1 turn/40 steps/Stopped，面板原因清楚；核对后刷新仍 paused，未发生第二轮。大文件本次人工验收标签复验通过，console warn/error 为空。
- 10 分钟使用实际计时测试，任务已于 04:44 启动；本条写入时尚未到时，不视为通过。精确 Token/费用归因不在本次实现内。


## 数据升级故障验证（2026-11-07 04:47）

- 从初始提交 `5ef77cc` 冻结 schema 2 夹具，升级到 schema 6 后 Bot/Task/Input 保留并可准备/派发新的 Run。
- 人为制造迁移 DDL 失败：新表与版本整体回滚，旧数据仍可读；修复夹具冲突后正常升级。
- 独立子进程打开 WAL 事务，执行部分 ALTER/新表/版本更新但尚未提交时 SIGKILL；重开仍是完整 schema 2，无半个升级；随后实际 Store 构造可完成升级与 integrity_check。
- `npm run typecheck` 与 `npm test`：33 项通过。故障测试仅操作系统临时目录，不中断测试宿主或个人数据库。此用例覆盖 SQLite 迁移事务的进程中断，不宣称模拟所有机器断电/磁盘损坏。


## 已有会话、取消边界与实际容量（2026-11-07 04:58）

- 实际 10 分钟计时完成：`smoke-budget.mjs time-verify` 于 600,026 ms 后观察 Run cancelled，原生 idle/空 inbox，无成果；核对后仍暂停。
- `npm run check`：36 项核心测试通过，新增已有会话双授权/事务回滚/归属冲突、初始暂停与旧请求 hash 兼容，以及根目录双向资源重叠测试。
- `smoke-attach.mjs`：真实已有会话保留合成历史；待处理输入拒绝关联、目录变化拒绝旧授权、双授权后暂停且无模型调用；显式恢复才执行新的 Input。两个任务并发争同一会话只有一方成功，同请求并发只生成一个 Binding。旧 attach 回执不能复活已解除的关联；实际普通 fork 可关联。
- 独立代码审查发现根目录资源重叠判断和历史 fork 的 `parentSession` 误判，分别改用 path.relative 包含判断及宿主 origin 字段；不凭父会话字段判断子 Agent。
- 第二次独立审查发现原生介入过早 release 和旧 Stop 重试可能取消后续人工轮次。现在定向撤回旧输入，取消未收敛前保持 guard；使用 DSH 的 idle 状态边界解除限制和旧执行句柄，不等待会跟随后续人工轮次的 whenIdle；旧 Run 终结后 Stop 仅回原回执。
- `smoke-handoff.mjs` 真实验证：不响应取消的旧模型仍 active 时，以全新未取消 signal 调用额外工具也被拒绝；原生两条用户输入保留，旧 driver idle 后新人工轮次可执行原生 scoped 工具；重试旧 Stop 没有中断新人工轮次。最后旧 Run 仍 interrupted、须显式核对。
- `smoke-stop-timeout.mjs`：合成模型故意不响应 abort，10,004 ms 后转 recovery；尚 active 时恢复拒绝；释放模型后虽 idle 仍不成功，明确核对才释放并暂停。
- `smoke-capacity.mjs`：同 Bot 两个 Worker 确实同时 running；第三任务容量不足时无 Run。另 Bot 的 Manager 保留容量通知；释放一槽后该任务执行并产成果，另一 Worker 同时仍 running。最后清理停止两项合成任务。
- 上述变更后 `probe:run` 的 11 项契约再次通过。真实模型、Desktop、运行中热卸载仍未验证。

独立第 19 轮 UI 完成：启用 Manager 后完整任务可初始暂停，期间无 Binding/模型执行；忙碌会话不给关联，空闲会话双授权才允许提交；关联后保持暂停和原 1 turn/1 step。恢复自动管理后 Manager 自动执行至人工待验收，原生 2 turns/4 steps、132 字节成果，历史只有一份，console warn/error 为空。SB-05 新建/已有授权/解绑/历史保留路径已具备实际证据。


## ready 与未收敛后台活动（2026-11-07 05:01）

- `smoke-background.mjs` 在真实报告工具前建立合成 DSH Job（没有外部进程）；Worker 写/读/ready 后 Agent 已 idle，但 Job 仍 running。产品 Run 转 interrupted/recovery，Result 只作不可验收候选，不能接受或释放占用。
- 请求 Job kill 后状态仍 stopping，恢复继续拒绝；测试明确完成 Job 后，人工核对才使任务暂停。旧 ready 不因后来空闲而自动恢复为可验收成果。
- 配合 11 项契约、实际取消超时、丢回执、重启、文件证据和独立 UI，SB-02/06～09 的文件任务纵切完成；仍保留支持矩阵中的限制，真实模型质量归 SB-15。


## Manager 预算实测（2026-11-07 05:09）

- `smoke-manager-budget.mjs steps`：自动管理轮次模型恰好 12 步，随后停止；增加程序侧可见原因，工作台不再只在原生错误日志里得知预算耗尽。任务保持暂停，没有 Worker Run。
- `smoke-manager-budget.mjs hourly`：实际 20 次自动唤醒后，其余 6 条通知保持 pending；等待期间模型调用不再增长。更换 Manager 后计数仍 20、新会话自动调用为 0、pending 变 7，不通过换会话绕过预算。
- `smoke-manager-budget.mjs time-start/time-verify`：使用真实墙钟，300,877 ms 后自动轮次取消并回到 idle，5 分钟原因在面板可查询；暂停任务始终未派发。当前 5 分钟限制针对自动唤醒轮次，原生手动管理对话受 12 步限制但没有该自动轮次计时器。
- 本次产品变更仅为 12 步原因的可见反馈；部署前 `npm run check` 36 项通过，独立 UI 第 20 轮复验中。


## Bot 配置与参考文本快照（2026-11-07 05:25）

- schema 7 为 Bot 保存参考文本快照，为每个 Task 固定创建时的职责、参考内容和配置版本；列表仅显示引用元数据，不加载参考正文。每份最多 16 KiB、最多 4 份，明确路径、UTF-8、普通文件；以非阻塞方式打开后检查文件类型，命名管道不会挂住宿主。
- 变更 Bot 设置需旧 Manager 空闲，异步读文件后重新核对身份、版本和原生活动；提交同事务撤销旧 Manager。重复同时保存共用一次操作，已成功请求的重试无需重新读取文件；无变化保存保留 Manager 和版本。
- 升级前实际一致性备份 schema 6：45 Bot、198 Task、66 Result，位于忽略的 `.runtime/pre-schema7-backup.json` 所指路径。停止测试宿主后构建、重启，原账本升级至 7；没有修改日常 DSH。
- `smoke-bot-config.mjs` 通过真实 DSH 模型输入标记核对：旧 Task 首次执行仍得到 A，新 Task 得到已保存 B，磁盘后来改成 C 不会自动进入任一任务；旧 Manager 无管理工具，新 Manager 收到 B。并发 create/update、删文件后的成功重试、无变化保存、旧版本及非法内容拒绝全部通过。
- 同一脚本验证：先创建 3 个任务再启用 Manager，3 个任务全部执行至待人工验收且已由 Manager 检查；不再只唤醒一次而遗漏后续积压。
- `npm run typecheck`、`npm test`、Host/Client 与探针构建通过；新增返工配额持久化验证后核心测试为 42 项。连续关闭重开 SQLite 并更换 Manager 不能重置两次自动返工额度，第三次转人工暂停。
- 独立 UI 第 20 轮已通过预算状态与原生计数核对；其两项易用性反馈已改为工作台直接显示小时限额、自动超时收敛后显示本轮已结束。第 21 轮正在复验设置表单与版本提示。


## 管理竞争与独立设置试用（2026-11-07 05:28）

- 独立 UI 第 21 轮通过：新旧任务分别显示创建时配置 2/1，刷新保持暂停和选中任务；旧管理入口失效、新管理对话可启用；错误参考路径拒绝保存，取消清除错误。20/20 与 7 条等待通知直接可见，控制台 warn/error 为空。
- `smoke-manager-capacity.mjs` 在真实宿主同时挂起两个自动 Manager，第三 Bot 保留一条 pending 且模型调用不增长；释放一个后第三开始，另一个仍挂起。工作中的 Manager 拒绝 Bot 设置修改。最后释放全部测试模型。
- `smoke-manager-stale.mjs` 在模型读取旧任务之后挂起。用户改目标再释放：模型确实发送旧 rowVersion 的 dispatch，但无 Binding/Run；原生 Worker 用户输入后迟到 dispatch 被拒绝；成果待检查时原生介入，迟到自动 accept 也被拒绝，任务 manual/open、无人工验收记录。
- 初次迟到命令夹具会在工具拒绝后再次挂起，是合成模型复用旧 tool 结果导致；改为每条通知仅挂起一次后，三条真实竞争路径全部通过，无需修改产品权限规则。
- 管理对话新建时增加名称、管理代数、配置版本；更新管理 Workspace 名称，便于区分更名后的新旧对话。已有 ready 会话不自动改名。此次 `npm run check` 42 项通过，UI 标题复验待进行。
- SB-10～12 的当前文件任务纵切完成；Shell/共享外部服务、真实模型质量仍明确后置。


## 故障窗口与已提交回执（2026-11-07 05:55）

- `test/transactions.test.ts` 在报告、settle、人工验收、Manager 返工的最后 requests 插入处触发 ABORT，核对所有业务表、资源、待办、通知、审计整体回滚；关库重开后仍无半条事务。去除故障后同请求可提交，再重开重试不增加记录。
- ready 已提交但尚未 settle 时重启恢复，候选保留但不可验收、资源仍占用；entered 写入失败时 enqueued 不提升为已进入上下文，报告拒绝，恢复保留未知占用。sending 的管理通知重开后转 unknown，迟到 entered 不触发重发或重执行。
- 独立审查找到 adapter 在 Store 回执之前检查 rowVersion/读取成果文件的问题。Manager 现在先核对身份与 Bot 归属，再按原 prepare/dispatch/review 操作查验回执；Worker 保存原请求文件路径并先取已提交报告，不因后续磁盘变化把成功回执误报失败。所有新操作仍执行完整版本、权限、证据检查。
- 补充审查修复：prepare 意图仅处于 creating/recovery 时仍要求核对，不能返回 prepared；已解除的关联不能借重试重新绑定。大文件 accept 降为 human 时，原判定与未截断说明也参与回执 hash，防止不同请求因展示说明截断而碰撞。
- `test/adapter/receipts.test.ts` 单独运行，不混入无 DSH 的核心账本测试。8 项覆盖准备/派发/各类验收成功后重试、同调用异参冲突、删除成果后的已提交回执、结束后的报告权限拒绝，以及 Fake 原 Agent 仍 active 时重新安装 adapter 的授权撤销/不重派/不释放。最后一项不代表真实宿主热卸载已验证。
- `npm run check`：49 项核心测试、8 项适配测试、类型检查和构建通过。修复后真实 `probe:run` 11 项再次通过；真实 Manager 返工与大文件转人工回归通过。
- 独立 UI 第 22 轮通过：新 Manager 标题含 Bot 名、管理 3/4 和配置 2/3；更名同步管理 Workspace，旧标题保留，两项任务始终暂停，console warn/error 为空。


## 实际安装包与首次运行修复（2026-11-07 06:04）

- npm pack 的产品包仅包含 Host/Client 构建、manifest、schema、README/运行能力表和恢复脚本；无测试模型、数据库、日志、node_modules 或凭证。新建 `.runtime/package-test` / `super-bot-package-test`，用实际 tgz 安装并启动 3082；认证、拒绝跨域与 WAL 检查通过。
- 独立 UI 第 23 轮验证包资产和原生导航正常，但发现 DSH 默认 route 使 `model.current()` 非空：未选模型也派发，原生报缺凭证，工作台仅泛化待核对。没有配置账号或成功调用真实模型；留下合成失败任务，未自动恢复。
- 修复使用 DSH 官方 `sessionProjections.snapshot(...,['modelSelection'])`，只读取模型选择投影；默认 fallback 不作为选定模型。Manager 给新 Worker 显式继承所选模型，更换 Manager 也保留实际选择。未选时不消费管理事件、不创建 Run。
- Worker 和 Manager 订阅原生 turn/end 结构化错误码，将缺凭证、认证失败、额度不足/无提供方映射成明确步骤；不保存提供方原始错误正文，不自动重试。既有 12 步预算原因不会被泛化错误覆盖。
- `npm run check` 49 核心 + 8 适配测试通过；`smoke-model-errors.mjs` 使用合成 MISSING_CREDENTIAL、真实原生错误事件验证两类提示与未选模型零调用；Manager 全闭环/更换与 12 步预算回归通过。
- candidate-2 tgz 停机更新后，`smoke-package.mjs prepare` 验证未选任务无 Run、普通会话/Manager 创建、一致性备份幂等和参考 A 文本快照（磁盘后来变 B）；UI 第 24 轮复验中。
