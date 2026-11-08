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


## 安装、恢复、卸载和实际回退（2026-11-07 06:17）

- 独立 UI 第 24 轮通过未选模型的拒绝与空原生会话、Manager pending 1 / wakes 0；没有选真实模型或添加凭证。
- 用 candidate-2 包内恢复脚本恢复到全新数据目录，实际启动后原任务/Session 引用保留、未完成任务 paused/recovery、Manager pending 0；原账本文件与备份哈希均未改变。UI 第 25 轮确认恢复说明、原生会话与管理标题可读，未点击核对或执行。
- 停机 remove 后再次启动：认证 API 返回 404，独立 UI 确认产品入口消失；原 Workspace、失败任务历史和管理会话仍保留。再安装 candidate-3 tgz、切回原账本，`smoke-package.mjs retained` 确认原任务/绑定/备份不变，没有模型执行。
- 只读审查发现若恢复前仍选中一个不在备份中的 Task，query not-found 会被当成全宿主 offline。客户端现在保留错误码，仅把选择相关查询的 not-found 视为失效选择；其他错误仍离线，Bot 消失时重选，页码超界时钳回有效页。UI 第 26 轮保持同页、不手动刷新/导航，切回旧备份后任务 2→1，消失任务与详情自动清除，宿主在线；仅停机期间连接重试警告。操作记录/连续 AX 支持同页更新，未取得独立 document timeOrigin 证据，不夸大成浏览器内部导航证明。
- 实际回退：从 Git `b19cb02` 构建 schema 6 旧插件包，使用该版本恢复脚本与升级前一致性备份。在停止 schema 7 测试宿主后，使用同一独立 DSH home、新 profile/新数据目录启动旧包于 3083；查询得到 45 Bot、198 Task、66 Result，176 项未完成任务全部暂停/待核对，管理 pending 0。旧脚本对 schema 7 备份在创建目标目录前拒绝。回退验证后停止 3083，重新启动原 3081 schema 7 宿主。
- 滚动小时额度补证：原 20 次唤醒已实际超过一小时，旧计数归 0，7 条通知仍保留；显式为替换会话选择无网络测试模型后，7 条处理完、计数 7，全部暂停任务仍没有 Worker Session。证据 `.runtime/manager-hourly-rollover.json`。
- 安装清单与用户恢复步骤补齐，提供 `docs/first-trial.md`。SB-14 完成当前支持范围，SB-15/FV 等待真实账号/模型质量与个人最终验收。


## 分页恢复时保留编辑草稿（2026-11-07 06:23）

- 收尾审查发现分页越界钳回时仍会无条件关闭所有表单；改成只关闭依赖失效任务的任务编辑表单，保留 Bot 设置和新任务草稿。
- 独立 UI 第 27 轮使用实际 candidate-4 包：同一 Bot 原有 30 项暂停任务，在第 2 页打开 Bot 设置并输入未提交名称；停机切到仅 2 项任务的备份，同页自动恢复为第 1/1 页，表单与输入原样保留。取消后 Bot 仍是原名称，无保存/执行/模型选择；仅停机连接重试警告。
- 修正安装文档中的数据位置与手动执行前提，包内 docs 入口只链接随包提供的使用文档。类型检查与构建通过；领域逻辑未变，既有 49 核心与 8 适配测试继续作为当前基线。


## 备份发布断点与首次试用说明（2026-11-07 06:30）

- 收尾检查复现：SQLite 快照已 rename、清单尚未发布时中断，旧实现重试同一请求会用更晚账本覆盖首次快照；已有清单但 SQLite 文件删除或损坏时也会误报成功。
- 现在优先复用已经发布的 SQLite，缺清单时从原快照重建；有原回执/清单但文件缺失时明确拒绝，损坏文件也不会被替换。新的请求仍可创建新快照。没有新增表或迁移。
- `test/backups.test.ts` 新增 3 项故障用例，先复现失败，再修复通过；`npm run check` 52 核心 + 8 适配测试、类型检查与构建全部通过。独立代码复核未发现阻塞。
- candidate-5 实际 tgz 停机安装于 3082；`smoke-backup-retry.mjs` 在首次快照后新增合成 Bot，再移除清单重试，计数与文件哈希保持原快照；临时移开 SQLite 后返回 backup-unavailable，最后原文件/清单保留。原安装包生命周期任务与备份的 retained 检查再次通过。
- 独立文档审阅修正：回答/返工保存后的 Manager 自动安排与手动开始条件、从原生菜单复制 Session ID 的步骤、旧报告保留但文件版本不自动备份的区别。UI 提示同步；修改后的类型检查/构建通过。真实账号/模型判断与最终个人体验仍留待用户。


## 安装包备份反馈复验（2026-11-07 06:34）

- 独立 UI 第 28 轮确认 candidate-5 在线、原任务与原生会话可打开、返回仍选中任务、一次备份成功且范围清楚，console warn/error 为空。发现页脚操作后的成功提示在屏幕外。
- 成功提示加入 status 语义，并在新备份返回时滚入可视区域；没有自动重试备份。candidate-6 实际 tgz 的独立 UI 第 29 轮从页脚点击后不手动滚动，路径、范围与关闭按钮均自动完整可见，关闭正常，无控制台告警。截图位于 `.runtime/ui29-backup-auto-visible.png`。
- 移除初期最小插件留下的 create-probe-session 产品 API 与无使用者的 savedSessionId 状态字段；不删除已有原生会话或元数据。真实安装包 status 正常、旧临时接口返回 not-found；类型检查/构建通过。契约测试插件继续单独存在于开发 profile，不随产品包交付。


## Manager 更换的历史回执边界（2026-11-07 06:40）

- 独立收尾审查实际复现三条：配置改变后重试旧 prepare 会读空 current；旧 replace 成功后原会话忙碌导致重试误报；更重要的是旧 replace 重试会把 gen1 模型带到新配置的 gen3，使本应等待选模型的会话获得执行能力。
- 准备回执现在绑定原 Manager ID 并读取其当前状态；ready/released 历史只读返回。更换已释放后的恢复仅对应该请求的 :new；尚无准备记录时要求配置未变且无其他当前 Manager。已提交重试不重新选择模型；中断恢复的新对话必要时由用户显式选择。
- 首次正常继承在异步 resolve 后重新核对当前 ID、配置、ready 状态和已有选择；配置变化/释放后不选择模型。没有新增表、迁移或泛化调度机制。
- `test/adapter/manager-lifecycle.test.ts` 5 项覆盖上述顺序、清空选择后重试、释放后中断、同配置另一个准备请求及异步解析期间配置变化；`npm run check` 52 核心 + 13 适配测试、类型检查和构建通过。独立补丁复核通过。
- `smoke-manager-lifecycle.mjs` 在真实 DSH 以无网络模型跑 gen1→gen2→新配置 gen3，旧请求只返回原代 released；gen3 保留通知、modelSteps 0、自动唤醒不增长、提示选择模型。随后 `smoke:manager` 完整派发/验收/聊天建任务/跨 Bot 拒绝/正常更换回归通过。


## 最后安装包回归与搜索边界（2026-11-07 06:45）

- candidate-7 tgz 的实际 API 再走三代 Manager，旧请求返回 gen2 released、gen3 pending 保留/自动唤醒 0；原安装包任务/会话/备份 retained 检查通过。重建契约插件后，`probe:run` 11 项再次通过。
- 搜索接口限制 200 字符，但 UI 原来没有对应限制。独立 UI 第 30 轮发现单加 maxLength 时，CUA 两种自动化粘贴路径仍能送入 220 字符，界面误显示离线；输入恰好 200 字符则正常。不把自动化路径等同于已证明人工浏览器粘贴必现。
- 在组件 onChange 同时截断到 200 后，独立 UI 第 31 轮复用 220 字符输入，DOM value.length=200、宿主在线、正确无匹配，清空后恢复 2 项任务；console warn/error 为空。类型检查与构建通过，未修改业务执行逻辑。


## 干净预览入口与交付包（2026-11-07 06:48）

- 最终包位于忽略目录 `.runtime/releases/preview-20261107/zxdvd-super-bot-0.1.0.tgz`，提供 release-info.json 和 SHA256SUMS；此时 SHA-256 为 `a0b695454b2739a583105c149dfbae1bc7b2ae70d2be41d7069a39b84a2062cf`。包构建源码提交 `0c46df1`。
- 在全新 `.runtime/preview` / `super-bot-preview` 安装该 tgz，监听 3083。所有包内文件与实际安装内容逐字节相等；没有测试插件、数据库、日志、node_modules 或凭证。源码文档 31 个本地链接存在。
- 实际 API 确认 Bot 列表为空、SQLite WAL、运行版本 rc.1、契约探针 API 404。独立 UI 第 32 轮确认欢迎页、原生导航、宿主在线及控制台无告警；未创建 Bot、选模型或备份，保留欢迎页供用户首次体验。
- 已停止带测试模型的 3081 源码宿主；不会把测试模型当作用户试用入口。最终真实账号/模型质量、Desktop 与用户验收保持待完成。


## 待机观察与夜间交付结束（2026-11-07 06:58）

- `smoke-idle.mjs 960` 对实际安装包的未选模型 Manager 连续观察 960,010 ms，共 33 次采样。宿主没有重启，当前代数和 pending 通知保持不变，自动唤醒始终 0、任务始终 0。该宿主 Host 构建与最终包一致；之后仅客户端搜索输入限制有变化，已另经 UI31/32 验证。
- 观察结束后停止 3082 测试宿主，3081 已停止；保留 3083 的空白预览。日常 DSH 3080 与机器默认 Node 22.22.3 未修改，项目验证仍使用 fnm 的 Node 24.21.0。
- 当前验证基线：52 项核心、13 项适配测试，11 项真实宿主契约，32 轮独立 UI 迭代（发现问题后修复复验），实际包安装/卸载重装、恢复和旧版本回退；最终产物的所有文件与干净安装逐字节一致。
- SB-15/FV 和提案 implementing 状态保持未完成：真实模型质量与个人体验需要用户自己的账号和判断；没有把确定性宿主验证等同真实模型验收。


## 用户确认的产品方向修订（2026-11-07，夜间预览之后）

- 用户指出当前产品偏向任务监督系统，并确认目标是聊天为主入口：自然交代事情，由 Bot 安排执行并回来交付。要求复用已有底层、避免过度设计，先完成这一流程。
- 重新核对原始基线“以 Bot 为入口”和“聊天表达意图”，以及当前 src/ui/Workspace.tsx、src/manager.ts：界面仍需启用/打开管理对话，工具动作仅 list/detail/create/dispatch/review；对话回答/人工返工没有工具入口，原对话交付没有独立产品验收。已有自动唤醒与账本可复用，不需要重新搭建执行平台。
- 原 change 原地修订，当前方案状态改为 ready，新增 06-chat-first.md、CF-01～04 与 C01～C06；SB-00～14 保留底层历史证据，SB-15/FV 重新依赖聊天主流程。早先 implementing 状态与“只待个人验收”的描述属于当时进展，不再代表当前计划。
- 同步 README、ROADMAP、相关模块契约、试用说明、协作规则与 workspace 项目索引。没有修改实现、数据库或安装包，没有将新流程勾选为完成；既有测试数仍只作底层基线。
- 文档自查：Why/范围/验收/任务的依赖一致，CF-01～04、SB-15/FV 均未勾选；38 个本地 Markdown 链接存在，git diff --check 通过。本次仅修改文档，未重跑或新增运行测试。


## 2026-11-07：聊天主流程最小实现与复验

本轮按用户“快速推进，不要过度设计”实现 CF-01～04 的最小入口/工具，复用原生会话、现有任务与通知账本，没有新建聊天数据库、消息协议或 Agent Loop。

- 首页改为 Bot 列表；创建只填名字即可，职责默认助手。创建/选择会自动准备并打开原生 Bot 对话；“工作与设置”保留原面板。创建时保留宿主导航信号，用户切走后不抢回页面。
- `super_bot_manage` 的 create/respond/rework 依赖本轮真实 `user/message`，记录 sessionId/messageId/seq/原文。自动通知和已结束轮次无法伪造新工作或人类反馈。反馈直接使用用户原文，归属、版本、幂等和人工验收约束保留。
- 交付继续使用现有 Outbox 唤醒同一 Bot，对话返回摘要、文件与准确任务链接；成果 GET 只允许账本 resultId/索引并重新校验文件哈希。DSH Web Markdown 不渲染相对链接，独立 UI 第 34 轮实际发现后改为 `webServer.getOrigin()` 的完整 HTTP(S) 地址；没有修改宿主源码。客户端对本产品链接复用原面板导航，下载不会接受成果。
- 独立代码审查发现并已修复：创建途中导航竞争、强制人工验收字段、改名后列表刷新、深链接迟到响应覆盖。独立 UI 第 33 轮发现的空 Bot 初始化多余回复，已通过仅为实际待安排工作生成初始化通知修复；第 34 轮确认无工作时 pending/wakes 均为零。

验证：Node 24.21.0，DSH Web 0.2.2-rc.1。`npm run check` 最终通过 typecheck、52 核心测试、16 适配测试与 build；`npm run probe:run` 通过 11 项真实宿主契约。新适配案例覆盖来源、自动消息拒绝、回答/返工幂等与归属、下载字节校验、humanAcceptedAt 不被模型设置。

`npm run smoke:chat` 使用真实隔离宿主与确定性无网络模型：从原生聊天发起（未 API 预建任务/代派发），闲聊零任务；工作一项自动执行；原对话交付；认证下载成功/匿名拒绝；聊天返工复用任务并产生新成果；显式接受；第二项 Worker 提问→原对话回答→继续交付。该测试验证接线，不代表真实模型语义判断或成果质量。

独立 UI 第 35 轮：从原 Bot 对话点击文件，实际下载并回读 132 字节合成内容；点击交付确认链接直接到对应任务详情，无侧边浏览器；实际点击接受后完成数为 2/待验收为 0，再返回 Bot 仍保留原交付和链接。console 无警告或错误。截图仅在本地 `.runtime/ui35-result-accepted.png`、`.runtime/ui35-chat-delivery-links.png`；不把合成聊天当个人真实模型试用。

最终产品包 `zxdvd-super-bot-0.1.0.tgz` 清单 12 项，不包含测试插件、运行数据库、日志或凭证。另在全新 `.runtime/chat-preview` / `super-bot-chat-preview` 安装并启动 3084，HTTP状态确认固定宿主版本；不含测试模型，不改动3083已有Bot数据。源码探针宿主仍使用3081独立profile。

未完成：真实模型对缺信息请求的必要澄清、多任务歧义、交付质量与失败表达，以及个人最终体验；CF-02～04 的完整体验验收、SB-15/FV 保持未勾选。已有实现不表示首版完成。


独立 UI 第 36 轮（全新 tgz / 3084）补齐 CF-01 验收：仅名称创建“我的 Bot”后进入原生空对话；模型选择器未配置、任务为 0、pending/wakes 为 0；返回首页再打开仍为同一原生 Session，console 无警告或错误。预览 tab 保留供用户后续试用；截图 `.runtime/ui36-clean-chat-preview.png`。CF-01 已勾选；CF-02～04 的剩余真实模型体验项仍保留，不提交首版完成验收。

## 2026-11-08：真实 dogfooding 启动与 Worker 能力纠偏

- 使用用户指定的日常 `web` profile，真实 Bot 从原生聊天创建并派发一个修复任务；不是探针脚本预建任务。Bot 使用 GPT 6.1 Sol medium，Worker 使用同模型 xhigh。账号、聊天正文与运行数据不入仓库。
- 外层先完成启动适配（提交 `0e8dec4`、`7b31bb6`）：角色模型、Full Access 分支、项目工作目录；Full Access Worker 不附加文件工具白名单、目录守卫或 40 步/10 分钟预算。旧 files 模式保持用于兼容回归。
- 第一轮实际派发暴露旧包/运行实例仍生效：Worker 如实返回 waiting，说明没有 Shell、工作目录错误；没有假称修改或测试。复用同版本 tgz 会命中安装缓存，改用 `0.1.1` 新版本/文件名后核对安装文件与构建内容一致。
- 仅安装新版仍不足以证明已加载：新建会话一度沿用旧目录。外层在 Bot/Worker 空闲时重新加载本插件，保留同一任务、旧会话历史，更换执行关联并恢复管理；没有重启整个 DSH。之后 UI 确认项目目录，Bot 自动继续派发。
- 新 Worker 实际展示 Sol xhigh，并调用 Bash 核对 Git、读取仓库、使用原生子 Agent、写回归测试；运行已超过原 10 分钟上限。原生 `create_goal` 因不是顶层人类直接输入而拒绝一次，Worker 随后使用任务清单继续，未造成任务丢失。
- 权限 UI 显示 Custom，揭示仅设置 sandbox mode 不等于完整权限预设。外层改为调用 DSH `permissionPresets.set(..., 'danger-full-access')`，同时设置原生沙箱与审批策略；新增两个角色配置回归通过。此改动与文档由外层负责，P1 业务修复由真实 Worker 负责；运行中不替换插件，完整安装验证待本轮收敛后进行。

### 第一轮 P1 修复交付

- 实际 Worker 完成 25 分 38 秒、73 个原生步骤，使用 Bash 和两个原生子 Agent；超过旧步数/时间预算仍正常完成。通知、多消息来源、Review 与交付分离由 Worker 实际修改；外层未代做这些业务修复。
- Worker 报告 9 个源/测试文件，真实 `fnm exec --using=24.21.0 npm run check` 退出 0：63 核心 + 43 适配测试、类型检查及构建通过。最后定向回归 38/38、`git diff --check` 通过。外层直接观察了原生工具结果，而非只依赖最终文字报告。
- 外层新增的角色测试最初遗漏 SDK 推理档位品牌类型，完整检查退出 2；Worker 修正该夹具为 `ReasoningEffortId` 后重新通过，权限实现未被它改写。DSH 原生 changes 视图包含并发外层文件，不能把其中 16 个文件都归功于 Worker；报告明确区分了来源。
- Worker 的 ready 报告/收敛自动唤醒 Bot，Bot 在同一原生聊天检查源码和测试、记录人工待验收意见，并交付全部 9 个文件链接与原任务入口；没有人代点派发或验收，最终人工接受仍未发生。该次真实运行使用旧安装版执行，新修复随后打包为 `0.1.2`。
- `0.1.2` 包加入完整原生权限预设与显式持久服务依赖；安装文件与构建文件逐字节一致。下一轮以新版本验证；不把合成失败窗口测试表述为真实宿主崩溃验收。

### Full Access 原生注入边界修正

- 空闲宿主启用 `0.1.2` 时真实报错：不能在未注入的 `agent.ctx` 上读取 `permissionPresets`。原角色测试伪造了 Agent Context 上的服务，未覆盖 Cordis 的真实注入边界，不能拿单测通过替代宿主启动。
- 外层改为向角色配置传入插件 Context，使用已显式注入的原生权限服务；测试中的 Agent Context 现在主动拒绝属性读取，防止退回原错误路径。交付测试夹具同步到正确服务归属。
- `0.1.3` 再次完整 check 通过（63 核心 + 43 适配、typecheck/build），使用新版本 tgz 安装并核对构建字节一致；没有修改 DSH 上游或安装源码。此启动修正由外层完成，非 Worker 的 P1 业务修复。

### 第二轮 P2：Worker 最小修复与本地回归（待人工验收）

- 开始实际核对 Shell、Node、fnm、Git：仓库为 `/Users/zxd/coding-spaces/repos/super-bot`，HEAD `e04304fe5912b814b1fb0728a25e4a8730c66f51`，初始 `git status --short` 为空。默认 Node 22.22.3，所有本轮测试显式通过 fnm 使用 24.21.0；Git 2.50.1、fnm 1.39.0。先读取项目指引、README、ROADMAP、活动 change README/tasks/evidence 及相关契约，未发现 GLOSSARY 或独立 ADR。
- Worker 的业务改动仅 [manager.ts](../../../src/manager.ts)、[store.ts](../../../src/store.ts)，新增 [p2.test.ts](../../../test/adapter/p2.test.ts)；本节是额外的脱敏验证记录。没有改架构、UI、schema、执行适配或权限配置，不安装本轮构建，不更改第一轮任务的人工待验收状态。

最小诊断与红绿闭环（测试仅使用 `.runtime/p2-adapter-*` 内合成账本/文件及合成原生宿主边界；测试中实际注册的管理工具、应用事务、派发、报告、验收和证据读取代码实际运行）：

1. 无 binding 的缺项任务：`fnm exec --using=24.21.0 node --import tsx --test --test-name-pattern='P2 incomplete unbound' test/adapter/p2.test.ts` 连续两次退出 1，均为原路径 `not-execution-question`。排序假设为管理入口误走执行问答、问题版本/归属失效、补充字段未入账；实际错误栈与字段状态定位到第一项。修复后同命令退出 0：`respond` 只从当前真实用户消息填尚缺 scope/acceptance，事务内检查任务/问题版本与归属、保留完整来源、推进 taskRevision/rowVersion，随后实际 prepare/dispatch，Worker 输入包含新字段。不改变目标、已有非空字段、reviewPolicy 或暂停/manual 控制。
2. 文件修改/删除导致详情不可读：`fnm exec --using=24.21.0 node --import tsx --test --test-name-pattern='P2 (modified|deleted) evidence' test/adapter/p2.test.ts` 退出 1，两个用例分别抛 `evidence-changed` / `evidence-unavailable`。排序假设为预览异常冒泡、账本投影损坏、接受/下载校验问题；错误栈与独立元数据对比定位第一项。仅在 detail 隔离已知证据预览错误，返回 `evidenceValidation`，失败时不返回任何部分预览，保留 task/result/run/attentions/events/交付入口；同命令修复后 2/2、退出 0。真实 `DshExecution.accept`、Manager accept 和下载使用的 `readEvidence` 对修改/删除文件仍拒绝；真实用户消息可按原范围请求返工，自动通知不能冒充用户。
3. 同真实消息同意图跨 callId 重建：`fnm exec --using=24.21.0 node --import tsx --test --test-name-pattern='P2 same native message' test/adapter/p2.test.ts` 退出 1，规范化字段完全相同而 taskId 不同。排序假设为只有 callId 回执、字段未一致规范化、内存去重重启丢失；实际创建字段相同且重启前就重复，定位第一项。复用 SQLite requests，在同一创建事务中保存真实会话/有序完整消息身份 + 规范化任务意图的回执，保留原 callId 冲突检查；修复后同命令退出 0。重开实际 SQLite 后仍去重，同消息不同 goal/scope/acceptance、不同消息相同目标及相同文本均允许；外层回执失败会回滚任务与意图回执，不依赖 Prompt。

已执行的最终检查：

- `fnm exec --using=24.21.0 node --import tsx --test test/adapter/p2.test.ts`：最终 11/11，退出 0。额外覆盖部分缺项分次回答、自动通知拒绝、完整多消息来源、版本冲突/问题失效、禁止覆盖已有授权、暂停保持、调用重试/账本重开、空字段规范化及故障事务回滚；损坏预览 await 期间取消、Manager 替换仍拒绝失效权限，不因证据错误回退吞掉授权错误。
- 独立子 Agent 只读审查发现“已提交 Worker 回答→解绑→同 callId 重试”会被新增分支误当补全、报 `idempotency-conflict`；新增真实管理/解绑入口测试，`--test-name-pattern='P2 committed Worker answer'` 实际退出 1。排序排查为可变 binding 导致命令种类切换、来源改变、版本问题；保持同来源/参数的栈定位到第一项。最小改为按请求是否携带 scope/acceptance 字段稳定路由，不按当前 binding；同一回归随后退出 0。审查者复看后无剩余阻塞发现，未改任何文件。
- `fnm exec --using=24.21.0 node --import tsx --test test/adapter/p2.test.ts test/adapter/multi-message.test.ts test/adapter/receipts.test.ts`：当时已有的 3 个 P2 补全用例及原回归共 17/17，退出 0；之后新增的其余 P2 已纳入完整检查。
- `fnm exec --using=24.21.0 npm run check`：本轮两次实际完整执行都退出 0。初次 63 核心 + 51 适配 = 114；审查修复与新增保护用例后最终 63 核心 + 55 适配 = 118 测试、typecheck 与 Host/Client build 通过（最终打印 `FINAL_CHECK_EXIT=0`）。其中新增 11 项 P2 来自本 Worker，另 1 项 fresh-profile 配置回归为外层并发新增，不冒认。包括第一轮 P1 通知/多消息/交付与既有 files、原生 Full Access/Context 注入回归；不是沿用外层的 106 项结果。
- 最终组合定向测试（P2、multi-message、receipts、runtime、delivery）50/50，退出 0；`git diff --check` 退出 0。`git diff --exit-code e04304f -- src/dsh.ts src/runtime.ts test/notifications.test.ts test/adapter/multi-message.test.ts test/adapter/delivery.test.ts test/manager-delivery.test.ts` 退出 0，关键旧执行/权限/P1实现及回归未被修改。HEAD 仍为 e04304f。
- 开始写测试时有一处末尾笔误使首次调用语法失败（退出 1），已修正，未当成业务红测。没有加入调试日志；合成目录由测试核对路径后清理。原生 create_goal 因 Worker 非顶层人类调用被拒绝一次，随后用任务清单推进，没有绕过拒绝。

并发与限制：验证中发现外层另外修改 [package.json](../../../package.json)、[build.mjs](../../../scripts/build.mjs)、[dev.mjs](../../../scripts/dev.mjs)、[tasks.md](tasks.md)，新增 [dev-reload.mjs](../../../scripts/dev-reload.mjs)；后续还修改 [README](../../../README.md)、[runtime-support](../../../docs/runtime-support.md)、[index.ts](../../../src/index.ts)、[runtime.test.ts](../../../test/adapter/runtime.test.ts)（可选角色配置及 1 项回归）。这些非本 Worker 所改或所交付，未覆盖。检查时确认 check 仍只执行 typecheck/test/test:adapter/build，普通 build 不安装或重载宿主；完整结果针对当时工作树，非隔离分支。未运行开发热加载脚本、真实宿主探针、安装、重启、真实宿主破坏性操作、Git 提交或推送；未修改凭证/其他项目。未验证部署后的真实模型聊天质量、实际浏览器下载/接受点击和异常表达；这里的文件下载拒绝覆盖其实际 `readEvidence` 校验入口，未冒充真实 HTTP/UI 验收。第一轮与本轮的最终人工确认均仍待用户决定。

### 外层收尾：第二轮真实交付与日常开发热加载

- 第二轮 Worker 实际运行 19 分 18 秒、55 步，完整原生 Shell 与只读子 Agent 可用；外层直接展开原生最终 Job 输出，看到 63 核心 + 55 适配测试通过、typecheck/build 成功及 `FINAL_CHECK_EXIT=0`，不是仅转述报告。外层审查实际源码 diff 与关键事务/权限路径，没有发现新的阻塞问题。
- Worker 报告并收敛后，Sol medium Bot 自动唤醒，48 秒内在原对话检查、说明三项修复并交付三个源码/测试链接；真实工作台出现 `manager.delivered` 持久回执。第一轮新增的原生 Session flush/readback 交付确认已在实际宿主成功运行；没有重新执行 Worker。两项任务均为待人工验收，已完成数为 0。
- 业务修复由产品内 Worker 完成，外层将其独立记录为提交 `8c1db9b`。外层另外实现开发 HMR 脚本、修复全新 profile 可选模型配置，并更正工作面板两处仍暗示只支持文件/必须手动选模型开始的旧文案；这些不冒认为 Worker 成果。
- 开发热加载的官方机制、失败实验和隔离真实验证见 [development-hmr.md](../../../docs/development-hmr.md)。随后在 Bot 和 Worker 都空闲时，外层实际执行 `fnm exec --using=24.21.0 npm run dev:reload` 更新日常 web profile，退出 0。没有升版本、打新 tgz 或重启 DSH。
- 日常 profile 的 manifest 和真实链接路径指向本仓库；DSH PID 保持不变。Plugins 刷新后显示 `link:` 源码来源、版本 `0.1.3`、`1 total · 1 running`。前端自动重挂载，重新打开工作台看到新文案及原来的两项待验收任务；原生 Bot 会话与模型仍保留。Plugins 旧详情在刷新前缓存旧 tgz 来源，不应据此误判加载失败。
- 隔离 HMR 宿主和构建监听已退出；`npm pack --dry-run` 包含新增开发说明，不包含 `.runtime` 或实际聊天/日志。最终只有文案/文档/分发清单在 Worker 的完整 check 后继续变化；文案已重新构建并在日常浏览器实际显示，没有为纯文案重复整套测试。
- 尚未把新版三个 P2 的每个分支都做真实模型/HTTP/UI 端到端复验；这些有实际应用/适配层回归，不能冒充用户已验收。旧第一轮源码证据在后续迭代后可能 hash 失效，原结果没有被伪造为仍可接受；第二轮的三个报告文件保持原 hash。

## 2026-11-08：respond 空可选字段小修复（本轮待人工验收）

- 本轮 run `f081d7ec-0c01-4a61-a29e-309f69eb06cf`，初始工作树干净，HEAD 为 `62fbb6a973477ce37f1c9249a3409d280fbfb6b1`；已读取仓库指引、README、ROADMAP、活动提案/任务/证据及聊天契约。Node 显式选用 `24.21.0`，未改变机器默认版本。没有覆盖或冒认基线的外层目录预留上下文修正。
- 实际注册 schema 中 scope/acceptance 为可选 string，无默认值/minLength。核读仓库已安装 DSH `0.2.2-rc.1` 的 ToolsService、NativeToolExecutor 与共享 pipeline：原生 JSON.parse/参数快照保留省略与精确空字符串，未观察到该入口自行补空。因此不把上游归一化位置当成已证实事实；测试直接重放两种合法工具载荷，不自行伪造“归一化器”。
- 在原 P2 夹具接入真正的 Cordis ToolsService 注册/激活、NativeToolExecutor JSON 参数解析与结果封装；Manager、执行适配和 SQLite 账本均运行产品代码，只有会话/模型/文件目录为合成边界，不访问日常宿主或真实用户聊天。根因：respond 仅按字段存在性判断，`scope: ''` / `acceptance: ''` 误入 completeTaskInput，随后 requiredText 返回“请填写任务范围/验收条件”。
- 红测命令 `fnm exec --using=24.21.0 node --import tsx --test --test-name-pattern='respond native tool accepts' test/adapter/p2.test.ts` 在修复前实际执行两次，均退出 1：首版在省略成功后的空字段重试报“请填写任务范围”；展开成四种首次输入后，首次单空/双空分别报上述准确错误，省略用例在交叉空形式重试时报同错。不是强制改源码制造红测。
- 排查顺序为字段存在性误路由、绑定/版本变化、原生参数转换；不改变绑定和版本的新问题首次空字段也失败，原生解析保留载荷，且错误落在原补全校验，定位第一项。最小修复只改 [manager.ts](../../../src/manager.ts) 一处分流：undefined/精确 `''` 均为中性；任何其他值仍原样进入补全校验。分流不依赖可变绑定；不整体 trim、不吞 null/false/0/数组/对象/空白/超长/有值请求，不改变补全路径中另一空字段的既有拒绝行为。
- 同一红测命令修复后 4/4、退出 0。后续扩大验证命令 `fnm exec --using=24.21.0 node --import tsx --test --test-name-pattern='respond native tool' test/adapter/p2.test.ts` 最终 6/6、退出 0：四种首次输入及同 callId 跨四种空形式重试；解绑、账本重开、重新绑定后仍回原 Input；空字段回答实际派发至同一 Worker，Input entered/原问题 resolved，授权与 taskRevision 不变；完整有序去重多消息来源；自动通知/伪 rpc/no-rpc/外会话拒绝；旧 rowVersion/问题拒绝；同 callId 改字段或来源拒绝；turn/end 撤权。两字段的空白、非空、超长与非法类型均返回原准确错误且不创建回答。
- 原缺项完整补全与分次补全成功调用已接到同一原生工具边界；两次补充仍推进版本、保留已有 scope/acceptance、禁止覆盖已有授权，历史补全回执在后续版本和新绑定后仍幂等。原暂停保持、完整来源、跨 Bot/问题归属以及事务/证据回归保留。
- 最终组合定向命令 `fnm exec --using=24.21.0 node --import tsx --test test/adapter/p2.test.ts test/adapter/multi-message.test.ts test/adapter/receipts.test.ts test/adapter/runtime.test.ts test/adapter/delivery.test.ts`：56/56，退出 0（`TARGETED_FINAL_EXIT=0`）。
- `fnm exec --using=24.21.0 npm run check` 本轮实际两次退出 0；最终包含新增消费链路用例，63 核心 + 61 适配 = 124 项通过，typecheck、Host/Client build 均通过，打印 `FINAL_CHECK_EXIT=0`。消费链路用例首次误用了不存在的 detail.inputs 数组而退出 1，按公开 detail.input 修正后通过；这次夹具断言笔误不当作业务红测。早期隔离注册探针曾因 Cordis provide/清理 API 使用错误退出 1，修正为实际注册/注销接口后原生回归已执行通过。
- 独立只读审查未发现 must-fix；另用内存账本实际运行安装库原生链路探针，退出 0，核对四空形式首次/解绑重试与非法有值/来源/版本拒绝。此结果不冒认为父 Worker 的组合测试或全量 check。
- `git diff --check` 退出 0；对照 `62fbb6a` 核对执行/权限/入口/Store/model、schema-version、package/lock 无差异，退出 0。实际改动只有本轮 [manager.ts](../../../src/manager.ts)、[p2.test.ts](../../../test/adapter/p2.test.ts) 与本节脱敏证据；未修改数据库/schema/权限机制、profile/凭证、DSH 安装源码、其他仓库，未提交/推送、升版本、dev:reload 或重启/部署。测试合成目录均在仓库 .runtime 下，清理前核对真实路径。
- 未验证：加载后真实 Provider 的参数适配、真实模型对话/UI 端到端、人工验收；本轮安装库接线测试不代替这些事实。外层待交付空闲后 HMR，再按账本继续原工作视图 `cd3174c7-6c2b-4426-bb70-aa8436c0c892` → 说明 `e9c2efdf-1511-4517-84ad-4b8dfdb2a4e2`，无需再次确认目录释放。本 Worker 未取消/修改或绕过账本实现这两项任务，最终接受仍由用户决定。
