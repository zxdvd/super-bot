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

## 2026-11-08：DF-06 聊天旁工作视图（本轮待人工验收）

- 本轮 run `06b05469-5f20-46fa-a755-d67f4581c65d`。重新核对 cwd 为本仓库，起始工作树干净，HEAD 为 `ad73346890746e64a31063acb0e0b9cb3ab2ced9`；`74b2205` 是实际祖先（`git merge-base --is-ancestor 74b2205 HEAD` 退出 0）。先重读 AGENTS、README、ROADMAP 和活动 change README/tasks/evidence；用户已明确搜索安装任务收敛交付，账本已预留本目录，本轮未再询问、轮询、重派或干预安装。`62fbb6a`、`ad73346` 及更早的 Worker 提示修正属于外层，不冒认。
- 只读研究本仓库已安装 DSH `0.2.2-rc.1` SDK 的类型与实际 JS。`conversation.session.header.actions` 是严格 session 的增量槽；原生空白对话会隐藏 header，因此另注册增量 `conversation.hero.options`。右栏通过 `sidebarRightTabs.register` + `sidebar.right.pane.tab` 两阶段注册，按原生 `props.sessionId` 和 `useTabInfo()` 接线；不占用 root/rightbar/corner，不重做聊天。原生右栏源码已含 `<768px` 全屏规则，本实现复用该规则，不能将此静态研究写成浏览器实测。
- [client](../../../src/client.tsx)、[SessionWork](../../../src/ui/SessionWork.tsx) 接入顶部/空白页“工作”和原生右栏 guide 入口；同一按钮可打开/收起，面板“返回聊天”仅 hide 当前 tab，不准备或导航另一个 Bot。侧栏选任务后直接显示详情，“全部工作”返回列表，避免详情被长列表挤到下方。首页辅助工作页补了返回该 Bot 聊天动作。
- [Workspace](../../../src/ui/Workspace.tsx) 与 [styles](../../../src/ui/styles.ts) 默认按“哪里需要我 / 正在做什么 / 交付了什么”呈现，分组数量标为本页，不冒充全局统计；保留搜索、总数、分页及筛选。目标列表限两行，详情摘要限三行，完整目标/范围/验收、报告/验证、执行会话、审计、管理设置与账本维护默认折叠。回答、停止、恢复、取消、返工、人工接受仍走原有应用命令，文件链接走原认证/哈希校验接口；下载不接受成果。
- 后端只新增 [Store.botForSession](../../../src/store.ts) 与 [只读 API action](../../../src/index.ts) `bot.for-session`：同时核对 ready、当前 Manager、当前配置和 Bot.managerSessionId。普通会话、Worker、旧 Manager 或配置过期对话均不映射；没有新表、迁移、聊天数据库或执行循环。侧栏锁定查询所得 Bot，不读写普通工作页的 Bot/任务选择记忆，也不在失效时回退到另一 Bot。
- [work-navigation](../../../src/ui/work-navigation.ts) 对原生 mounted 源直接订阅，会话切换时同步 abort/清空旧归属，覆盖 React 尚未重绘前的 A→B→A；隐藏/卸载、迟到成功与错误都不能重新发布旧内容。按钮和返回动作同步校验当前原生会话。异步准备与 [交付链接解析](../../../src/ui/BotHome.tsx) 检查原生导航 signal，迟到结果不回拉页面；面板写操作重新核对 session 归属，并以生命周期/当前选择/导航 signal 防止迟到回调打开旧会话。
- 独立只读审查发现初版 UI 将所有未完成 Result 标为“待确认”不真实（ready 尚未收敛、已返工、取消后都可能保留 Result）。已改为：review 才“待你验收”，completed 才“已接受”，其他为“候选报告 · 当前不可验收”或“历史报告 · 任务已取消”。真实 Store 回归贯穿 ready→settle→pause→reject→cancel，另覆盖 ready→recovery，确认报告保留且 humanAcceptedAt 仍为 null；审查者复看后无剩余 must-fix。没有把这次审查或单测说成用户已接受。
- 新增 [work-view.test](../../../test/adapter/work-view.test.ts) 11 项：实际 Store 的双 Bot/普通/Worker/旧会话与配置失效归属、只读性、对应任务页隔离；生产 watcher 的迟到响应/错误、A→B→A、全局面板与卸载、Manager 更换；实际客户端注册和伪造 tab params 无效；准备/交付链接迟到导航、原生开关目标守卫、真实状态投影。Store 与客户端代码实际执行，原生 UI/导航服务是合成边界，不是浏览器/宿主激活验收。
- `fnm exec --using=24.21.0 node --import tsx --test test/adapter/work-view.test.ts`：最终 11/11，退出 0。组合命令（同样的 Node，文件为 work-view、p2、multi-message、receipts、runtime、delivery）：67/67，`TARGETED_FINAL_EXIT=0`，包含 `ad73346` 的空可选字段真实工具链路和前轮 P1/P2/Full Access 回归。
- `fnm exec --using=24.21.0 npm run check`：最终退出 0，63 核心 + 72 适配 = 135 项，typecheck 和 Host/Client build 全通过；Node 实际打印 `v24.21.0`。源码最后一处“完整说明”展开文案后又完整执行一次并打印 `FINAL_CHECK_EXIT=0`，原始合成测试日志仅在忽略的 [.runtime 检查日志](../../../.runtime/df06-final-check-XXXXXX.log)，不随产品提交。检查脚本未加入安装或重载行为。
- `git diff --check` 退出 0；`git diff --exit-code ad73346 -- src/dsh.ts src/manager.ts src/runtime.ts test/adapter/p2.test.ts docs/development-hmr.md schema-version.json` 退出 0，外层提示、respond 修复、角色权限和 schema 未覆盖。产品版本仍 `0.1.3`。[package](../../../package.json) 和 [lock](../../../package-lock.json) 仅把已存在的 sidebar-right/conversation/session 三个 rc.1 包补为直接 dev/peer 与 client inject 声明，无安装、无新包解析。开始及收尾状态均未观察到额外并发源码变更，本轮全部源码差异为本 Worker，外层基线提交不计入成果。
- 限制与交接：本轮未执行实际浏览器宽/窄屏、空白/已有聊天入口点击、真实 UI 回答/停止/恢复/返工/接受、刷新/工作页选择记忆复验，也未验证真实模型体验或 HTTP 下载。未执行 `dev:reload`、安装、宿主重载/重启、Git 提交/推送或升版本；未修改 DSH 安装源码、凭证或其他项目。只做源码构建，不能承诺当前 GUI 已更新；待 Bot/Worker 空闲后由外层原生 HMR 并做上述浏览器验证。DF-06、SB-15/FV 不因本次源码交付勾选，前两轮及本轮成果都待人工验收；未填补或修改说明任务 `e9c2efdf-1511-4517-84ad-4b8dfdb2a4e2` 的缺项或状态，交回 Bot 按既定队列继续。

## 2026-11-09：DF-08 原生侧栏命名与安全整理（run083，待人工验收）

### 本轮事实与范围

- 当前 run 为 `08311e89-da61-485d-a144-74895513c17c`。重新核对 cwd 为本仓库、HEAD 为 `589c245e386e360a13d76e0d91f2a6892cf15a5b`；本轮开始已有前一尝试 `e9619ce2-be6e-4162-90e0-bdc2a020650b` 遗留的 10 个 tracked 修改与 2 个 untracked 文件，均为此项 DF-08 工作，未冒称本轮从干净工作树开始。前一尝试的检查不作为本 run 的完成依据，本轮重新读指引/DF-08/原生契约、审查实现、补修复并完整重跑。没有回滚或覆盖其他任务成果，也未询问目录释放。
- 初次实施已读 [AGENTS](../../../AGENTS.md)、[README](../../../README.md)、[ROADMAP](../../../ROADMAP.md)、活动 change README/tasks/evidence、Bot Workspace 与执行契约；本轮再次读取相应当前内容。只读研究仓库安装的 DSH `0.2.2-rc.1` SDK 类型与发行 JS，不改 SDK 或宿主。静态发现：Worker 的 `super-bot` 消息不属于原生标题生成接受的 `user` 来源；Workspace create 按 canonical path 复用且不更新旧 title；Workspace 没有命名来源/owner/CAS，不能以旧名文本或目录推断独占归属。

### 最小机制与验收边界

1. **新命名**：[Worker 适配](../../../src/dsh.ts) 在确认 Binding 前写原生短标题（首段最多 24 个 Unicode code point + 短 task ID），新项目 Workspace 使用目录 basename。复用原生 Session、Workspace、标题事件与 Host SessionStore.flush，不增加侧栏、表、schema、聊天数据库或通用框架。Manager 使用 Bot 名，但不再无条件覆盖已有 Workspace/会话标题。
2. **可靠归属及用户名称**：[Store 查询](../../../src/store.ts) 要求当前 Bot、匹配 Binding/task 及 `session.preparing` 创建事件，排除外部授权 attachment 和过期目标代数。[整理适配](../../../src/sidebar.ts) 再核对原生 Session ID、root/nonseeded、cwd 和当前 Manager 身份；只从 Host live SessionStore 取已加载对象，不 resolve/resume 冷历史。原生 `sessionTitle.get` 的 undefined/fallback/provider 才可整理；任何 user 来源都保留，包括文本恰好为 Untitled/旧自动名的情况。同步检查来源→原生 rename，无 await 间隙；realpath 后重查归档、live 对象、taskRevision，flush 后重查 Manager，防迟到变更越界。
3. **幂等及失败恢复**：原生 rename 产生 user 来源后，重复整理不再追加或覆盖，仅重试持久化检查；flush=false/throw 均不谎报成功。新会话创建仍先落意图/claim，未知回执只找同 requested ID，不二次 create。明确返回不同 ID 的事实保存在现有 metadata 中并保持硬性待核对，后续不自动收养原 ID；当前无自动解除标记/重建 UI。Manager partial attach failure 会恢复同 ID 的 Workspace membership，且先核对 root/nonseeded/目录，避免拒绝前改动其他资源。同任务返工保留 Binding/Session/短名或用户名，不新建或接受成果。
4. **置顶与归档**：[工作视图](../../../src/ui/Workspace.tsx) 增加显式“置顶主聊天”“整理自动会话名”，经原有认证 API 调用原生能力。只有用户点击置顶才调用 pinSession；prepare/open/tidy 永不 pin/unpin，因而不重置取消置顶偏好。整理不 archive/unarchive、不派发、不取消或改人工验收。任何已存在 Workspace 均不自动 setTitle；即使像插件旧长名，也保留原生手动改名。冷历史、不确定历史和归档留原生手动处理，不为了隐藏待验收/待返工 Worker 改生命周期。

### 本 run 的实际验证

- 新增“Manager seeded/subagent 恢复必须在 membership mutation 前拒绝”两项回归：`fnm exec --using=24.21.0 node --import tsx --test --test-name-pattern='recovery before mutating' test/adapter/sidebar.test.ts` 在本轮修复前实际退出 **1**，2/2 因 attach 计数 1 而非 0 失败。将已有完整身份检查前移至 Workspace create/attach 之前，并在 await 后复核 released；下述本轮回归全部通过，未强改实现制造红测。
- `fnm exec --using=24.21.0 node --version`：实际 `v24.21.0`、退出 **0**。
- `fnm exec --using=24.21.0 node --import tsx --test test/adapter/sidebar.test.ts test/adapter/manager-lifecycle.test.ts test/adapter/p2.test.ts test/adapter/work-view.test.ts`：**61/61，退出 0**，打印 `RUN083_TARGETED_EXIT=0`。其中 DF-08 新增文件本身 28 项，包含真实安装库 SessionTitleService 的规范化/source/log-append 语义；其他宿主能力、durability checkpoint 和侧栏对象为合成边界，产品 Store/适配代码实际执行。
- `fnm exec --using=24.21.0 npm run check`：本 run 实际重跑 **退出 0**，**63 核心 + 100 适配 = 163 项通过**，typecheck、Host/Client build 通过，打印 `RUN083_FULL_CHECK_EXIT=0`。原始合成输出仅在忽略的 [本轮检查日志](../../../.runtime/df08-run083-check.PL9Vid)，不随产品打包。
- 回归覆盖当前 Bot/其他 Bot/普通及 attachment、重复整理、用户取名 Untitled/后续改名、用户取消置顶、未加载/归档/fork/子 Agent/目录不符、create accepted-then-throw、并发重试、rename/flush 失败、false flush、Manager partial attachment、native 不同 ID 两次调用拒绝，以及 realpath 期间改名/归档/更换 Manager/移除 live Session/改变目标版本；同任务 review→返工仍保留 Session 与用户名称、humanAcceptedAt=null，零自动归档。
- 本轮最终 `git diff --check` **退出 0**（`RUN083_DIFF_CHECK_EXIT=0`）；对照 `589c245` 的权限/模型配置、领域模型、schema、原聊天旁入口/导航、build/dev/reload 脚本无差异，**退出 0**（`RUN083_PROTECTED_BASELINE_EXIT=0`），HEAD 未改变。检查期间未观察到额外并发源码变更。
- 独立子 Agent 只读审查了原生契约及实现，发现的 partial attachment、mismatch 重试、异步核验窗口均已有保护与回归。本轮进一步实测并修正了 header 验证顺序；审查者复看新 delta 后无新增 must-fix。静态审查不是实际宿主验收。

### 全部改动文件（13 个，正式报告选 10 个关键文件）

- 源码 6 个：[sidebar](../../../src/sidebar.ts)、[dsh](../../../src/dsh.ts)、[manager](../../../src/manager.ts)、[store](../../../src/store.ts)、[index](../../../src/index.ts)、[Workspace](../../../src/ui/Workspace.tsx)。
- 测试 3 个：[sidebar.test](../../../test/adapter/sidebar.test.ts)、[manager-lifecycle.test](../../../test/adapter/manager-lifecycle.test.ts)、[p2.test](../../../test/adapter/p2.test.ts)。后两者仅调整新增原生能力的合成宿主接线；Manager late-inheritance 用例仍在已 ready 后的解析窗口检查撤权，没有删除或放宽既有业务断言。
- 文档/声明 4 个：[本证据](evidence.md)、[README](../../../README.md)、[package](../../../package.json)、[lock](../../../package-lock.json)。后两者只把已经安装/锁定的 session-title rc.1 补为根 dev/peer 声明，无安装、新解析或版本升级；正式报告证据链接的额外三文件为 README/package/lock，不能因只提交 10 个关键路径而遗漏披露。

### 未验证与交接

- 本轮未在日常 profile 执行探针、整理或真实聊天操作；未安装、HMR、dev:reload、重载/重启正在执行的插件或宿主；未修改 DSH 安装源码、其他仓库、真实 profile/凭证；未升产品版本（仍 0.1.3）、提交或推送 Git。权限/模型配置、schema 和开发重载脚本不在本轮改动范围。
- 待外层在 Bot/Worker 空闲后加载，通过产品能力验证真实侧栏的新 Worker 名/项目名、已有真实历史的可整理覆盖、置顶→手动取消→再次打开/整理、用户改名、同任务返工，以及按钮反馈/宽窄屏。已有 Workspace 名或冷历史不是自动迁移承诺；不可安全推断的保留原生手动操作。构建通过不表示当前 GUI 已加载，也不等于真实浏览器或真实模型验收。
- DF-08、SB-15/FV 不因源码交付勾选；所有既有和本次成果保持待人工验收，由 Bot 在原对话交付，用户决定是否接受。

## 2026-11-09：默认 Full Access 与 CLI 委派修复

- 起点 `9b3ec12`，`dev` 工作树干净。按约定读取 README、ROADMAP、handoff、活动 change；不访问用户实际飞书消息、日常 Session 或凭证。
- 确认根因：Config 默认 false；Worker/角色配置用 truthy 判断，省略配置也落入 files 工具/预算分支。Manager 仅强调“file work”，files 提示没有准确开启方法；Full Access 时又不限制 Manager 原生执行工具，允许绕过 Task 自行尝试。
- 红测：`fnm exec --using=24.21.0 node --import tsx --test test/adapter/runtime.test.ts test/adapter/delivery.test.ts` 在修复前 25 项中 5 项失败，分别观察到 schema=false、省略配置未设置原生 preset、Manager Bash guard 返回 undefined。原始输出仅留 `.runtime/permissions-red.log`。
- 修复：统一 `fullAccessEnabled(options)` 为 `fullAccess !== false`；schema 默认 true，示例与升级说明同步。默认 Worker 使用原生 `danger-full-access`、不附加工具白名单或步数/时间预算；显式 false 保留原文件隔离。Manager 在所有模式只暴露 `super_bot_manage`，并以执行 guard 拦截其他工具；成果检查仍走 detail。提示明确 CLI/外部工具（包括 lark-cli 只读查询）必须建 Task 派 Worker，不能从 Bot 工具集推断 Worker 没有 Shell。files 模式先说明“Worker 完整权限未开启”及当前 profile 的 `config.fullAccess: true`，不要求开启工具通道。
- 回归覆盖省略/true/false 三种模式、真实 dispatch 分支中的 preset/工具/预算、重复 dispatch 回执与人工接管撤权、Manager mask/guard/模式指令及交付恢复后的作用域。旧 files 夹具改为显式 false；账本、schema、停止与交付机制未改。
- 最终 `npm run check` 退出 **0**：Node **24.21.0**，**63 核心 + 106 适配 = 169 项**，typecheck 与 Host/Client build 通过。日志 `.runtime/permissions-check.log`。`git diff --check` 通过。
- `npm run probe:build` 与最终 `npm run smoke:chat -- .runtime/permissions-host.log` 均退出 **0**。使用新建独立 home `.runtime/access-smoke-1et6Bc/super-bot/.runtime/dsh`、profile `super-bot-access`、端口 3097；DSH Web **0.2.2-rc.1**，测试 overlay 直接加载本地 `lib/index.js` 与独立 probe 插件，省略 fullAccess 配置，并关闭该测试宿主 HMR。未改 DSH 安装源码、日常 profile 或现有 dsh-plugins。
- chat smoke 从原生用户消息开始，不预建 Task：普通聊天零 Task；文件接单、原对话交付/下载、问答、同任务返工与显式接受通过；新增 Shell 请求创建第三项 Task，Worker 实际执行原生 Bash `printf` 写入合成文件，再 read/report，Bot 回原对话交付。核对 Worker 有 bash、工具结果无错误、下载内容为 `LOCAL_CLI_OK`；Bot 模型可见工具只有 super_bot_manage，实际调用也只有该工具，CLI 成果仍未人工接受。结果仅留 `.runtime/chat-smoke.json` 与 `.runtime/permissions-chat.log`。
- 测试环境排障：首次 plugin add 因 PATH 无 pnpm 失败，改为专用 overlay 加载具体模块文件；初次 Shell smoke 夹具漏传原生 bash 必填 description，导致 ready 无有效文件而进入 recovery，没有假成功。补齐参数后完整 smoke 通过；最终源码检查后重启专用宿主再跑也通过。没有把这些夹具/接线错误归因为产品权限故障。
- 边界：确定性模型证明接线与强制角色边界，不证明真实模型的自然语言判断。Desktop 原场景、真实 lark-cli 登录/读群消息、日常宿主加载与用户体验仍需复验；CF/SB-15/FV 不因本次测试勾选。外部 CLI 缺失或账号错误应由 Worker 报告实际错误，不能以“没有工具通道”替代调查。

## 2026-11-09：仅补交付通知无限循环修复

- 基线 `e8e967b`（上一个默认权限修复），开始于干净 `dev`。另一台机器的账本未访问；用本地合成账本/原生事件边界重现用户提供的 pending、attempts 持续增加现象。
- 红测：`node --import tsx --test --test-name-pattern='unbounded wakes|relative links' test/adapter/delivery.test.ts` 两项均失败：8 次结束/重开循环累计 9 次 wake（预期原检查 1 次 + 补交付最多 3 次）；包含正确成果/任务 ID 的相对链接、换序查询和不同端口仍是 pending。原始合成输出 `.runtime/delivery-loop-red.log`。
- 根因确认：`managerEventUnknown` 与 `resetUnconfirmedManagerEvents` 将 entered deliveryOnly 无条件翻回 pending；只有每 Bot 每小时 20 次的总预算，没有每事件上限和退避，也未用持久化结束事实约束重排。`reconcileDelivery` 对当前 webOrigin 生成的所有完整 URL 做字符串包含比较，导致等价链接被漏认。无法断言远端用户的某条回复究竟是哪一种链接差异。
- 修复 [Store](../../../src/store.ts)：复用 outbox.attempts 和 JSON payload，最多 3 次补交付（不含原检查轮次），后两次分别在上一轮确认结束后等 30 秒、60 秒。原子 claim 再检查上限及期限；第三次未确认转 unknown，以持久标记只写一次 managerProblem。结束证明绑定 session/turn/endSeq/messageId，重复结束回调、重启及晚到旧输入不能重置期限或产生第二次唤醒。不改表/schema、不增加通用调度层。
- 修复 [Manager](../../../src/manager.ts)：已进入但未结束的通知不再因 idle 或重载重排；先 flush/read 原生日志，确认对应输入和结束，再安排有界补交付。未知发送、缺失结束证明、补交付轮次中断保留 unknown；交付阶段仍不能执行 Worker/修改任务。旧 pending/attempts=14 先核对历史，正确交付则 done，否则到限停止；不会因升级多补一次。
- 链接按 `/api/super-bot-file` 的 resultId/index 和根页面 hash 的 taskId 匹配，支持相对链接、参数换序、HTML &amp;、不同 origin/端口；每份文件仍需对应链接。错误路径/任务/成果、缺序号、仅提到裸 ID 不算交付。保留原 Review/input 之后的顺序、最终模型回复、成功 turn/end、原生日志持久化及当前成果版本约束；没有新增“模型声称已交付”的完成捷径。
- Desktop 只读研究：本机 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 当前 package 为 **0.2.2-rc.1**。`dsh-desktop-host/lib/index.js` 启动参数为 `--host 127.0.0.1 --port 0`，并向 Electron 返回该监听端口的 authenticatedUrl；打包的 `dsh-host-webserver/lib/index.js#getOrigin()` 与仓库安装库一样使用协议、绑定主机及实际监听端口。因此 Desktop 使用 HTTP 回环动态端口，不是固定 Electron 自定义 origin；重启可能使历史链接端口与当前 origin 不同。本次没有启动/修改 Desktop 安装包，也不把静态研究称作用户桌面端验收。
- 定向回归 `node --import tsx --test test/manager-delivery.test.ts test/adapter/delivery.test.ts`：**40/40** 通过。覆盖缺失/缩短链接跨轮次及重开后的硬上限、30/60 秒精确边界、重复 turn/end、发送未知/结束未知、旧 attempts=14 的已交付和未交付分支、到限后晚到正确回复、问题记录稳定，以及既有持久化失败、交付恢复、返工/撤权保护。
- 最终 `npm run check` 退出 **0**：Node **24.21.0**，**65 核心 + 116 适配 = 181 项**，typecheck、Host/Client build 通过。首次完整检查的 TypeScript 可空 input 收窄错误已修正，以上为修正后实际全量结果；日志 `.runtime/delivery-loop-check.log`。`git diff --check` 通过。
- `npm run probe:build` 与 `npm run smoke:chat -- .runtime/delivery-loop-host.log` 均退出 **0**。新建独立 `.runtime/delivery-smoke-*/super-bot/.runtime/dsh`，profile `super-bot-delivery`，DSH Web rc.1、端口 3097、关闭测试宿主 HMR、仅确定性模型。原生聊天接单、Shell Worker、文件下载、同对话交付、问答、同任务返工及显式人工接受链路通过。该 smoke 验证正常聊天无回归；故障/退避由上面的确定性事件回归验证，不混称为真实模型质量测试。输出 `.runtime/delivery-loop-chat.log`，测试会话/账本不入仓库。
- 未验证：远端实际账本、远端 Desktop 运行、真实模型改写链接的所有形式；未替日常 profile 安装或重载。旧端口链接的历史交付识别不保证旧下载地址仍可打开，当前工作面板仍是查看成果入口。首版最终用户体验验收保持未勾选。

## 2026-11-09：用户批准 Bot 原生查询工具与 noWait

- 基线 `c80f28d`，开始于干净 `dev`。读取 AGENTS、README、ROADMAP、handoff 及活动 change 后实施；本次覆盖 e8e967b 的 Bot 管理工具独占策略，保留默认 Worker Full Access 和 c80f28d 补交付修复。不改账本/schema、Worker 执行或宿主安装源码。
- 参考用户提供的 `deepseek-ai/dsh-superagent-prototype` sessions.ts 片段及 sleep 正则，没有声称拉取/验证原型最新版本。只读核对本仓库安装的 rc.1 Bash/Jobs/Tools SDK：Bash 必填 description/command，standard 默认等待 60 秒；job_output 的 wait 默认 false，但 wait=true 未指定 timeout_ms 时默认等 30 秒。后台 job 由宿主向原 Session 通知。
- [Manager](../../../src/manager.ts) 默认/true 白名单为 skill、bash、read、read_image、job_output、job_list、job_kill 和 super_bot_manage；guard 再拒绝其他工具，保留撤权及仅补交付限制。[noWait](../../../src/manager-tools.ts) 对所有 preset 要求正数 timeoutMs <=30000 或 run_in_background=true；显式超限仍拒绝。拒绝常见 sleep；job_output 等待必须显式正数 timeout_ms <=5000。不实现通用 Shell 解析器或只读安全沙箱。
- 指令允许短只读/状态/lark-cli/Shell skill 查询直接在 Bot 执行，不建 Task；代码/文件修改、多步骤和长任务仍经账本委派 Worker，后台查询保留 job ID 后返回等原生事件。语义分类是模型职责，程序强制可用工具和等待参数。Bot 原生工具也受 fullAccess 控制：显式 false 只留管理工具并提示当前 profile 的 config.fullAccess:true 开启方法；不让用户开启不存在的工具通道。schema 说明与示例同步。
- 定向 `node --import tsx --test test/adapter/delivery.test.ts`：**39/39** 通过。新增 4 项边界/撤权测试并更新模式及补交付作用域断言，覆盖缺省/true/false 精确工具集、允许查询、拒绝 write/edit/subagent/外部工具、Bash 前后台与无效/超限参数、sleep 常见语法及纯文本误判、job_output 非等待和 5 秒边界、旧 Manager 撤权。上次补交付上限、退避、重开、重复 turn/end 和链接识别回归保留。
- `npm run check` **退出 0**：Node **24.21.0**，**65 核心 + 120 适配 = 185 项**，typecheck 和 Host/Client build 通过；日志 `.runtime/manager-query-check.log`。`npm run probe:build` **退出 0**，日志 `.runtime/manager-query-probe-build.log`。
- `npm run smoke:chat -- .runtime/manager-query-host.log` **退出 0**：独立新建 `.runtime/manager-query-smoke-*/super-bot/.runtime/dsh`、profile `super-bot-query`、DSH Web rc.1、端口 3097，测试 overlay 关闭 HMR，省略 fullAccess。不修改日常 profile/真实会话，不使用外部模型或 CLI 服务。
- smoke 从原生聊天输入执行短查询：Bot 原生 Bash printf 实际返回 `BOT_QUERY_OK`，模型回复引用实际工具输出，Task 数仍为 0；模型可见工具精确八项。随后合成 sleep 工具请求在真实 NativeToolExecutor 路径产生 noWait 错误，仍为零 Task。文件修改请求则经 Task/Worker 原生 Bash 写文件，read/report 后 Bot 原对话交付，下载为 `LOCAL_CLI_OK`；保留普通聊天、源消息归属、文件下载与认证拒绝、问答、同任务返工、显式人工接受等共 **12 项 smoke 检查**。日志 `.runtime/manager-query-chat.log`，结果 `.runtime/chat-smoke.json`，都不提交。
- 未验证：Desktop 实际运行、真实模型对短查询/复杂工作的语义分类、真实 lark-cli 账号/读群消息、实际 skill 内容执行、Bot 后台查询完成通知的交互体验、全套旧宿主 smoke。本轮 files 模式由适配测试验证，实际聊天 smoke 使用默认 Full Access。未安装/重载日常插件；CF/SB-15/FV 保持原验收状态。

## 2026-11-09：Review 第一批 · P0-2 任务独立目录（含 P1-8）

- `workspace` 改为项目根：新任务落在 `<root>/.super-bot-workspaces/<taskId>`（返工代际为 `-g<N>`）；Git 根用基于 `HEAD` 的 detached worktree，并自动写入本地 `.git/info/exclude`。不退回共享根目录，符号链接目录拒绝。
- dispatch 遇 `resource-conflict` 与 `capacity` 同样入队资源等待通知并返回 deferred；pump 改用 `Store.dispatchBlocker` 判断名额与目录重叠，资源释放后再唤醒 Bot。
- 成果拒绝 `.ssh`、`.aws`、`credentials`、`*.pem`、`.env*`（含符号链接别名）；读取失败错误不再回显绝对路径。
- 回归：配置 workspace 连续两次 dispatch 得到两个独立目录且都在运行；旧绑定重叠目录 deferred、目录释放后 pump 唤醒；worktree 隔离写入、复用代际、主 checkout 状态干净；敏感文件拒绝。`npm run check` 通过。

## 2026-11-09：Review 第一批 · P0-3 显式 deliver

- `super_bot_manage` 新增 `deliver`（taskId、resultId、text）。校验当前成果与生命周期后，`Store.managerDeliver` 在同一 SQLite 事务里写入 `manager.delivered`（explicit）并把 `manager-event:delivery:<resultId>` 置 done；同一请求重放返回同一回执，不同请求对已显式交付的成果返回首次回执，同一请求不同正文为 idempotency-conflict。
- 链接由插件渲染为相对路径（文件 `/api/super-bot-file?resultId=…&index=N`、任务 `/#super-bot-task=…`），返回 `markdown` 供 Bot 原样回复；`detail.delivery` 同样改为相对链接，不再依赖 webOrigin。补交付作用域允许对本成果调用 deliver。
- 回复文本链接识别保留为兜底（旧会话/旧模型），不再是主路径；c80f28d 的 3 次上限与退避不变。
- 回归：deliver 后无链接的模型回复也不会再唤醒（5 分钟推进后 followups 仍为 1）、重放/重开返回同一回执、无绝对 origin；补交付轮次只能交付自己的成果。`npm run check` 通过。

## 2026-11-09：Review 第一批 · P1-5 create 一步派发

- `create` 默认（`dispatch` 省略或 true）在同一调用内 prepare（`<requestId>:prepare`）并 reserve（`<requestId>:dispatch`），返回 `{task,run}`、`{task,deferred}` 或 `{task,dispatchError}`；同一调用重试复用 run 回执，不重复建任务或运行。成功或排队后把冗余的 `created` 通知置 done。
- Bot 未给出范围/验收时使用保守默认值满足账本，不再阻塞；`dispatch:false` 保留"缺项→提问→respond"流程，原有两步 dispatch action 不变。
- 回归：一步创建得到 run、无待办、重试同一 run；配置 workspace 时第三个任务排队而非失败。现有澄清/两步测试显式使用 `dispatch:false`。确定性 host-probe 认可 create 直接返回的 run。`npm run check` 通过。

## 2026-11-09：Review 第一批 · P1-6 唤醒上限提示与可配置限额（含部分 P1-9）

- 达到每小时唤醒上限时写入 `managerProblem`（按消息去重，只记录一次；通知保留；下一次成功唤醒清除），不再静默 continue。
- 新增配置（schema 默认值同旧常量）：`maxRunningTasks`=2、`managerWakesPerHour`=20、`managerConcurrentWakes`=2、`managerTurnMinutes`=5。补交付 3 次、files 模式 40 步/10 分钟、Bot 24/12 步保持固定（推迟）。
- 回归：`managerWakesPerHour:1` 时第二个事件不唤醒、问题只记录一次且不刷新；`maxRunningTasks` 1/2 切换改变 capacity 判断。`npm run check` 通过。

## 2026-11-21：CF-03/04 问题与成果直达链接

- 基线 `4e3daea`。用户选择方案 1，从原生聊天打开既有「工作」右栏。可回答的 Worker 问题绑定 `taskId` 和 `attentionId`，新交付绑定 `taskId` 和 `resultId`。过期问题和成果只展示相应状态，旧成果需要明确点击入口才能打开新版。历史任务链接及交付核对继续走兼容路径。
- DSH Web `0.2.2-rc.1` 的原生 Markdown 会把根相对目标当本地文件路径，因此可见回复使用宿主 HTTP URL。验收使用独立 DSH home、实际浏览器和配置中的真实 GPT-6.2-Sol。第一次候选试用出现前端与后端版本不一致。外层检查浏览器实际加载的点击处理器，统一候选构建后保留两条原生问题链接继续测试。
- 通过原生输入框一次并行交代 A、B，两次 Worker 输入进入上下文与各自的结算时间证明重叠 **13.801 秒**。两个问题链接均从原聊天打开右栏。点击 B 再点击 A，只提交 A 的回答，账本的回答输入绑定 A 的问题，B 保持等待。重新打开 A 的已答问题，未出现回答表单。
- 从 A 的第一版交付打开右栏，下载内容与合成代号一致。通过原有返工表单提交一次修改，同一任务产生新版。旧消息链接明确显示「这份成果已被新版替代」，没有接受按钮。从新版消息打开并验收，账本记录新版的 `humanAcceptedAt`，下载包含原代号和返工要求的新内容。测试由外层 Codex 以隔离测试 owner 执行，个人首版验收另行记录。
- 同步回项目主目录后，重启隔离宿主加载主目录构建。在 1440 和 390 像素视口重新打开同一组历史链接，均保留单标签和原 Bot 对话，B 仍可回答，旧版提示和新版已验收状态一致。
- 主目录 `npm run check` 通过 87 项核心和 187 项适配测试、类型检查及构建。`git diff --check` 通过。独立确定性宿主 `smoke:chat` 通过 13 项检查，覆盖精确问题、新成果版本、旧文件哈希校验和历史链接兼容。原始运行证据位于源仓库忽略的 `.runtime/chat-links-validation/browser-evidence.json`，宿主日志包含本机启动令牌，应保留在运行目录。
- 自开发验证。通过现有 Super Bot 原生聊天派发实现任务，由其 Worker 和子 Agent 修改独立工作树。父 Worker 在子 Agent 收敛前结束，产品保留资源占用并转待核对。外层负责构建、浏览器复验，并修复首次与重试回答回执形态不一致的回归。核对原生会话与工作树后，通过正常恢复入口释放占用，再用同一开发 Task 启动只读收尾 Run。新 Run 完成并提交验证报告，Manager 审查后在原聊天交付，保留待人工确认状态。后续可把父 Worker 等待子 Agent 与最终报告的行为作为新的自开发验证场景。

## 2026-11-21：日常 DSH 的 Worker 子 Agent 收敛

- 使用既有 DSH Web `0.2.2-rc.5` 的 `web` profile 和聊天「Super Bot 自开发 · 子 Agent 收敛」。为加载原仓库的插件，保留 `rc.1` 并加入 `rc.5` 的声明和原生归属检查兼容。复现使用该版本的原有报告和轮次结束逻辑。
- 修复前真实复现 Run `378a9e43-a10a-469d-916a-4ed6b77a53f5`。原生父会话 `session-23617881-1398-4aa7-b9d8-09d70c887987` 调用 `subagent_fork`，子会话 `f3cba9a1-ed48-4d8a-b550-b79e704c1df5` 的头部记录相同父会话及 `origin: subagent`。北京时间 14:44:03.240 父 Worker 提交 `ready`，14:44:03.261 收到候选回执，14:44:03.358 父轮次结束。子 Agent 到 14:44:53.423 才完成，晚 50.065 秒。工作右栏显示「会话仍有子 Agent，需要先核对」，候选不可验收。子结果唤醒的原生父轮次结束后，通过同一右栏解除占用，复现任务留在「已暂停」。
- `node .runtime/daily-child-wait/read-trace.mjs before` 检查原生持久事件，按预期失败于 `Parent ended before the child`。由 Super Bot 在同一聊天派发修复 Run `b3eebf8b-be47-4fae-82c6-8a9ab3e54c95`，Worker 使用原始仓库进行修改和回归验证。
- 首次修复轮次在插件退出时中止。核对原生结束与后台作业后，在工作右栏恢复同一任务。按用户要求把日常 `web` profile 的 Super Bot Manager 和 Worker 设为 `magpie-responses` 的 `codex/gpt-6.2-sol`、`xhigh`。恢复 Run `d45b5f7a-a71c-4332-8069-4e925367d85e` 的原生请求记录确认该模型，轮次正常结束并提交修复成果。
- Worker 的原始报告入口回归先失败后通过。完整 `npm run check` 通过 87 项核心、199 项适配测试及代码检查、类型检查和构建。针对实际宿主的 `rc.5` SDK 另行通过生产源码类型检查和 199 项适配测试。回归覆盖原生结束接缝、报告前采证、待接收子结果、取消和目录占用、迟到事件及原进程结束证据。
- 在修复任务进入人工验收后通过 `npm run dev:reload` 热加载日常 `web` profile。DSH Web 进程仍为 PID `92961`。在同一聊天派发验证 Run `9ce185fb-9fd7-46eb-9c26-bae3ca7b229b`。原生子会话 `e42a6f13-22da-4a84-a28c-9b8b146bb6e0` 的头部记录真实父会话 `session-903df52d-cbf4-4a70-829c-2364743d70f4`。父子请求均记录 `magpie-responses` 的 `codex/gpt-6.2-sol` 与 `xhigh`。
- 北京时间 15:20:54.755 父 Worker 在子 Agent 仍运行时第一次调用 `ready`。15:22:05.653 子轮次正常结束，20 毫秒后首次报告返回 `accepted: false` 和 `subtree-joined`，未提交候选。父 Worker 在同轮读取原生子结果、核对标记文件。15:22:58.583 第二次报告接受两个附件并返回成果 ID `af04240d-9f23-493b-920d-1f2b291df95a`。15:22:58.659 同一父轮次正常结束。工作右栏显示「待验收」。
- `node .runtime/daily-child-wait/read-trace.mjs after` 通过，核对真实原生父子关系、同轮两次报告、原始事件顺序、两边实际模型、子标记及通过的报告附件。

## 2026-11-21 日常自开发后续

- 上轮实际观察到，插件退出能中断 Worker。旧作业全部结束后，仍有一条 `tool-jobs` 的 `next-step` 通知令恢复按钮拒绝执行。主 Bot 看见恢复任务，但解除暂停是另一个用户操作。原生模型选择也可能在重载后被角色配置覆盖。正在等子树时，聊天只显示报告工具尚未返回。以上问题各自在 DF-09～12 跟踪。
- [OpenClaw 的安全重启](https://docs.openclaw.ai/cli/gateway/restart-and-supervision) 在同一运行中的宿主做预检并合并延期请求，有独立的调度和完成信息。借鉴关闭新工作入口和列明阻塞项的做法。Super Bot 的开发重载在等不到许可时退出，保留活跃工作。
- [DSH 插件生命周期](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/) 说明旧插件清理与新插件启动各自独立。结合本地脚本和上轮实测，方案对比为人工查看空闲、命令写入前取得活宿主许可、以及修改上游 HMR。先实现第二种，并验证效果；上游自行重组需单独核对能力。
- [DS-Bot](https://github.com/Fei2411/DS-Bot#bot) 把模型和思考档位放在 Bot 详情页，同时让组管理员向原聊天汇报各阶段结果。模型可见性可复用这一入口，Super Bot 还要显示每次 Run 的原生请求事实。
- [Grok Bot 的公开工作流](https://docs.x.ai/grok-bot/how-grok-bot-works) 将编码委托和原对话交付相连，在工作记录和审批卡显示下一步。Super Bot 继续使用现有原生会话，并在卡片呈现阻塞原因和恢复入口。
- [DS-Bot 的更新实现](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/src/host/update.js) 在卸载前写更新记录，由下一实例识别已生效或失败，区分安装请求与结果。DF-09 采用相同的跨实例回执思路，另补活跃执行的许可。
- [DS-Bot 的交接卡](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/src/client/handoff-card.js) 从程序状态生成卡片，两次快速点击走同一保护，历史卡显示已结束结果。DF-10 复用 Super Bot 的任务版本和请求回执，并把原生阻塞原因放到当前任务上。[GitHub Copilot 的会话详情](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents) 提供实时进度与原会话直达，作为 DF-12 的展示参考。
- DF-10 新发现。在内存账本建立普通绑定和已正常结束的人工待验收 Run，确认没有打开的恢复事项，用当前版本调用既有 `resolveRunRecovery`。现实现把 `controlMode` 从 `auto` 改成了 `paused`，应拒绝该状态。加入 DF-10 命令层回归条件。另核对日常 DSH rc.5 的 `resolveAgent` 会加载尚无活 Agent 的会话，恢复预览应使用只读观察，显式操作时再解析会话。
- DSH 的 `tool-jobs` 完成通知可能包含实际作业结果。DF-10 分类时应保留原生通知，用户看到「已完成的作业结果待读取」才知道如何核对。只有原生 Job、会话及子树均可证明安全时才能放行。DF-09 核对两版安装包的 `hmr.runExclusive` 与 `reconcileProfile`，原生接口可串行重组；`hmr/reload` 是替换完成后的事件，无法拦截外部修改。
- DF-09 由日常 Web 的 GPT-6.2 Sol xhigh 在原仓库实现，修复 Run `5f80e6df-66d6-4c03-b15b-bd3a2c3e9196`。回归验证旧命令在无宿主时也会构建和改写配置，候选版本改为活宿主核准、隔离构建产物、原生应用和继任实例回执。完整检查通过 87 项核心、214 项适配测试。空闲时用既有配置监听方式首次加载许可入口，保持 Web PID `92961`。
- 实际忙碌验证通过。Run `f268b102-6d6b-4d6e-8f93-5099a4db410f` 的原生 Job 在 15:55:42 注册，15:57:07 结束。15:56:07 执行默认 `dev:reload`，进程返回 1，列出该 Run，profile patch 和发布的 Host/Client 字节一致。该 Run 15:57:22 原轮次结束并进入待验收。
- 实际空闲应用尚未通过。实测 `dev:reload -- --wait 120` 能等主 Bot 审查结束并取得许可，提交时 DSH 返回 `HMR transactions cannot be nested`。profile 和活实例 `0cd899f3-4553-4d34-8089-c3b065979602` 未改变。rc.5 的 HMR 用 AsyncLocalStorage 拒绝嵌套操作，官方 `watchConfig` 先退出当前事务上下文，再由 watcher 进入下一次串行重组。需复现真实异步上下文继承并修复空闲命令，DF-09 保持未完成。
- 小型 Node 验证发现，在 `AsyncLocalStorage.run(true)` 内创建的 HTTP listener 会让后续 HTTP 回调看到 `true`，即使客户端请求发自事务外。已通过同一日常 Bot 把真实失败返工给原 DF-09，Run `421bf26c-974d-4bd3-8dd1-317997d0ecb0` 已进入执行，随后再验证同一活宿主的原生应用。
- DF-11 新发现。同一 Worker 的返工 Run `421bf26c-974d-4bd3-8dd1-317997d0ecb0` 已出现归属轮次的模型回复，来源为 Codex GPT-6.2 Sol，但截至首批工具调用没有本轮新增的 `request/header`。此前有效 header 为同模型和 xhigh。逐次查本轮第一条 header 会把真实复用误显示为未知。
- 返工采用公开 `watchConfig` 注册私有触发文件。HTTP 处理提交意图，宿主 watcher 在下一次 HMR 事务内发布候选和重组，旧、新实例完成回执。覆盖插件在重组上下文中启动、连续两次重载、取消排队提交及 watcher 未观察到时的租约清理。完整检查通过 87 项核心和 217 项适配测试，rc.5 生产源码类型检查和 18 项重载专项通过。
- 返工候选在空闲的同一日常 Web 首次加载，然后真正由受保护命令连续应用。最初两次命令均返回新实例，但宿主重写了首次启用时追加的注释，令字节断言暂失败。待宿主正常化配置后再次连续执行两次，均退出 0 并核对 profile patch、manifest 字节不变。实例依次为 `b0f9eaea-d53e-4799-b2d8-6dcfff74b893`、`5c5a8a4c-af79-486a-bd84-19aff89e6d37` 和 `f91e978a-068f-444d-a0c1-57622b58a6cb`，PID 保持 `92961`。原聊天仍使用 Codex GPT-6.2 Sol xhigh，修复和活验成果仍在待验收。证据在 `.runtime/daily-reload-guard/idle-stable-proof.json`。
- 在最终实例中通过原聊天派发 DF-10，Task `1d2caa25-f451-4515-a415-0cb00626ee0b`、Run `4002fd46-9b28-499b-b04f-460fc66ace16`、Worker 会话 `session-a6b84680-1dbb-457b-98e5-b763e5311d7e`。原生请求确认为 Codex GPT-6.2 Sol xhigh，且已进入当前轮次。期间再执行受保护命令，退出 1 并列出此 Run，profile patch、manifest、发布的 Host/Client 与活实例均未变化。证据在 `.runtime/daily-reload-guard/final-busy-proof.json`。DF-09 完成，DF-10 仍在执行。

### DF-13 · 日常聊天并行与交错回复

- 在日常 `web` profile 的原 Super Bot 聊天一次安排 A「实际模型证据方案」和 B「等待子 Agent 展示方案」，Task 分别为 `06a8242e-ff0e-437c-a3e9-07e55ed0c4fb` 和 `0143595d-69c9-4a6c-ba36-4fdabe4bf01d`。两项在允许根目录下各用一个已有子目录，各写一份独立设计文件，各问一个具体问题，均由 Codex GPT-6.2 Sol xhigh 执行并保留人工验收。
- 根目录被 DF-10 占用时，原聊天分别回执排队，两个独立原生会话已经准备，尚无请求或轮次事件。B 的右栏详情同时显示「待安排」「开始执行」和「排队中：工作目录被占用……轮到时自动开始」，同一任务给出了手动和自动两种操作暗示。后续核对排队状态和实际启动，考虑让等待状态与主操作一致。
- Argo Workflows 把锁的等待、持有和全局并发上限分别处理，工作流状态显示当前锁信息。Super Bot 已按目录路径重叠和执行名额约束派发，资源可用时通过 Manager 通知接续。先实测接续延迟和归属，再判断是否需要让已有派发意图直接由调度器兑现。[Argo Workflows 同步机制](https://argoproj.github.io/argo-workflows/synchronization/)
- 新回归。用内存账本和实际 `Managers.pump` 预检构造同一 Bot 的两个通知。一条旧目录等待被占用，后一条同优先级的独立交付可发送。旧项在队首时，预检直接跳过整个 Bot，独立通知保持 pending，原生 Manager 会话查询次数为 0。将旧项标为已处理后再跑一次，立即查询唯一的对应 Manager 会话。后续让调度挑选当前可处理的通知，同时保留同一冲突资源的先后顺序和原有唤醒限制。
- OpenClaw 将同会话串行和跨会话并发作为两道独立的门，排队回复保留提出问题时的权限和对应执行归属。Super Bot 可保留每 Bot 单个 Manager 轮次，只让它收到当前可处理的事件。回答依旧以原生用户消息和明确的任务、问题 ID 为依据。[OpenClaw 命令队列](https://docs.openclaw.ai/queue)
- DF-10 的原生轮次于北京时间 16:33:30 结束。16:33:31 队列唤醒原聊天的 Manager，由它在同一原生轮次派发 A、B，无需手动启动。A 首轮 `7dc38bb1-533c-46b6-b261-b83fb341495a`，B 首轮 `67a1f31a-f3d5-4e68-ae9f-03fcabef1029`。原生输入分别于 16:33:42.713 和 16:33:46.820 进入各自会话；较早结束的 B 在 16:34:36.096 结束，活动重叠 49.276 秒。两条原生请求均记录 Codex GPT-6.2 Sol xhigh。日常工作栏同时显示「执行中」，随后均进入「等你补充」。截图保存在 `.runtime/daily-parallel/both-workers-running.jpg`。
- 原聊天两次自动展示 B 的同一问题，直达链接的任务和 `attentionId` 完全相同。原生记录中 B 由 A 的资源等待通知轮次顺带派发，B 自己旧的资源通知仍于 16:34:36.359 进入 Manager；B 的轮次结算通知又于 16:35:48.435 进入。后续核对启动成功后完成旧资源等待意图能否消除这次重复，同时保留真实的新问题和重试所需通知。
- B 先问，A 后问。在原聊天用精确问题链接先答 A「本轮实际模型」，然后插入只读查询，Manager 看到仅 B 还等回复，DF-10 待验收。再答 B「子 Agent 收敛轨迹」。原生持久记录中两次 `respond` 分别绑定原问题，两个会话各接到自己的一次新 Run 和标题。续跑重叠 6.889 秒。两份各 15 行的文件各自只含正确标题，均在同一原聊天各交付一次，工作栏保持人工待验收。起止、Task/Run、问题与成果 ID 的精简证据保存在 `.runtime/daily-parallel/proof.json`。
- 在原聊天派发「DF-13 · 修复并行任务的排队与重复通知」。Task `beb4fb3a-9b87-451a-b1f3-9afd941d8731`，Run `31f5c3dc-90cb-4bc3-a70f-d62a5c109d5c`，Worker 会话 `session-91a54e3d-ddaf-4709-8a92-d30760943218`。16:49:30.536 原仓库 Worker 输入进入上下文，真实请求为 Codex GPT-6.2 Sol xhigh。范围限通知队首阻塞、已兑现的排队通知重复及界面状态，保留并发根目录规则，后续在原 DSH 活验。

### DF-11 · 模型选择与实际调用的证据边界

- DS-Bot 让每个 Bot 有自己的配置模型和首次连接卡，原模型不可用时使用上次可用模型或回到设置。Grok Bot 在每个任务背后路由并隐藏终端用户的底层模型，其企业请求审计单独记录模型和请求标识。OpenClaw 状态将会话覆盖、配置默认和实际应答来源区分，从会话记录补足可证实的事实。Super Bot 的用户已明确指定 Worker 的模型和档位，需要覆盖派发前的来源与历史 Run 的实际证据。[DS-Bot 模型说明](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/README.md#models) · [Grok Bot 模型选择](https://docs.x.ai/grok-bot/faq) · [Grok Bot 请求审计](https://docs.x.ai/grok-bot/inference-hooks) · [OpenClaw 会话状态](https://docs.openclaw.ai/cli/status)
- DSH rc.1 与 rc.5 的本地声明都定义 `request/header` 为变化时写入的完整快照，`assistant/message` 与 `assistant/attempt` 携带 turn/step；入站任务来源包含任务、Run、输入、版本和绑定代数。日常并行 A、B 的第二轮都有归属正确的模型回复，却没有本轮新增的 header。两个真实 Run 均复用各自 Session 的有效 header，provider/model 与第二轮回复吻合，档位为 xhigh。原生 `model/selection` 可在请求前待生效，`request/context` 只记路由元信息；两者均不能独立证明某次实际出站请求。[DSH 模型投影](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core) · [DSH 请求重建](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/llm-streaming)
- 派发前显示 Super Bot 角色覆盖、明确的原生选择及可确认的继承来源。执行后用 Run 的原生轮次及同一已证实 step 的模型回复绑定当时有效的 header。最少记录 provider/model/effort、证据位置和来源，网关背后的版本只有宿主可证实时才显示；未知档位、失败发生在请求前、多个实际模型与历史记录不足均显式表示。OpenTelemetry 的 GenAI 约定同样将请求模型与响应模型分别记录。[OpenTelemetry GenAI 约定](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- 排队修复完成日常活验后，原聊天立即派发「DF-11 · 展示模型来源与实际调用」，Task `7161824e-0941-4d54-b9aa-b6a73df8247b`、Run `b3405d7c-1086-4c70-90b3-477af1a1e709`、Worker `session-30121258-9552-4b4c-bba1-aeff03de4ea6`。17:19:22.943 原生输入进入原仓库 Worker 上下文，首个请求为 Codex GPT-6.2 Sol xhigh。人工验收，后续用历史 A/B 回归及同一日常 DSH 热载验证。
- 切换前重新读原生 A/B 历史，保存脱敏验收基线 `.runtime/daily-model-recheck/native-baseline.json`。两个续跑均为原生第 2 轮，A 的输入和模型回复序号为 47/48，B 为 65/66。两轮各自会话在第 18 个事件记下生效 header，续跑各无新 header。两边原生模型回复均与自己的原生配置吻合。这四次运行有独立的任务、Run、会话、入站和结束坐标，可以在新版界面对照。

### DF-12 · 子 Agent 等待的展示来源

- Grok Bot 在侧栏把工作中、需要用户处理、新成果分开展示。OpenClaw 的子 Agent 状态进一步区分运行、等待子 Agent、已执行但结算待交付，并保留开始/完成时间和子会话入口；历史计数不用于证明执行者仍活跃。[Grok Bot 注意状态](https://docs.x.ai/grok-bot/settings-and-notifications) · [OpenClaw 子 Agent 状态](https://docs.openclaw.ai/tools/subagents/slash-command)
- Super Bot 已有两个真实等待接缝：父 Worker 的 `ready` 工具和原生 `agent/turn-stopping`。当前 `TreeCheck` 复用 DSH 的 `subagent/start/end`，也负责 Job 与子树收敛保护。rc.5 以运行树根的 carrier 发送事件，payload 含子 run、会话和直接创建者；rc.1 的事件归属仍需按各版本契约使用。已有生产路径应给面板提供只读事实，避免以工具卡超过一定时长、`parentSession` 单字段或模型自报当作等待依据。
- 展示真实父 Run 正在等待的起点、已知子会话、已用时间。子数未知时显示核对中，区分等待结果、取消、未知和正常收敛。历史用同一 Run 的明确开始与结束事件配对，时间戳来自宿主刷新或持久事件。只增加监督展示，既有 stop、收敛保护、结果候选与人工验收继续用同一路径验证。
- DF-11 日常验收后，原聊天派发「DF-12 · 显示实际的子 Agent 等待与收敛」。Task `10f88b4c-6842-4b70-8ce2-52852f6bfaa4`、Run `fc9cd6b9-cc4d-4521-9e76-276f67e51232`、Worker `session-9b92ddca-49b3-4b1e-88e2-c7927f3bafdb`。17:45:07.359 原生输入进入原仓库 Worker 上下文，实际首请求为 Codex GPT-6.2 Sol xhigh。此前的真实父子收敛校验 `node .runtime/daily-child-wait/read-trace.mjs after` 重跑通过，下一轮以真实子 Agent 核对新等待卡与历史。

### 后续发现 · 原聊天交付的可见回执

- 重跑 `node --import tsx --test --test-name-pattern='explicit deliver closes the notification' test/adapter/delivery.test.ts`。现行测试确认 `deliver` 工具一返回就关闭补交通知，最终助手回复完全没有成果链接时，后续轮询仍无补交。生成交付内容已经可证实，从原聊天直接打开正确版本仍缺对应证据。这一问题会影响正式聊天验收。[现行回归](../../../test/adapter/delivery.test.ts) · [交付事务](../../../src/store.ts)
- 在现行测试的副本增加反向断言，用同一插件源码、账本和 `deliver` 工具夹具重放。最终助手只说「请查看上面的交付卡片」，原生记录没有可打开链接。期望交付仍待处理，实际通知为 `done`，用例见红。私有运行证据 `.runtime/df14-receipt.3NWjqw/red.log`。实现与日常浏览器验收由 DF-14 跟踪。
- 进一步用同一条实际交付核对入口跑了两个红灯。助手把匹配的全部 Markdown 链接写进代码块，或使用结构一致但属于其他站点的链接，现有核对均把通知记为 `done`。如果 DF-14 复用持久回复核对，需要验证链接在聊天可点且属于当前宿主，同版本关联仍然适用。测试副本及失败日志见 `.runtime/df14-link-proof.c4XfMk/`。
- 校验真正的链接时也需要保留正常文件名。现有生成器直接把文件名插入 Markdown 链接标签。用候选解析器复验，`result]draft.md` 产生零个可点击文件链接，转义 `]` 后解析到正确的文件链接和原文件名。生成入口需处理合法文件名中的 Markdown 符号，避免让成果一直处于待交付。
- 可先复用现有最终回复的持久核对，显式工具成功只记生成内容，等精确链接和原生消息证据后结清。同宿主的另一选择是可重放的专用交付卡。核对了 rc.1 与 rc.5 均有 `tool.call.toolview`，Web 由该槽使用持久 `tool/result.meta` 渲染。先试卡片能否在默认折叠、重开原聊天及热载后直接访问，只有真实可见证据才足以结清。DS-Bot 的交接卡从宿主状态生成动作，提供同宿主参考。[DSH 工具呈现](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool#web-client-presentation) · [DS-Bot 交接卡](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/src/client/handoff-card.js)
- 本机 Web 的工具槽处于原生轮次过程节点内。正常结束的过程允许折叠，终态工具卡仍可能随之隐藏。验收需测默认视图的可达性，优先用现有持久回复核对关闭交付义务。卡片可以提供免模型转述的入口，是否作为完成凭据取决于实际 Web 复验。
- 原生 Web 的 `conversation.chat.turnTail` 提供一个位于轮次尾部的候选入口。本机 rc.1 与日常 rc.5 的 SDK 都有该槽。宿主 `present` 交付据原生事件重放尾卡，打开调用会话的现有文件。Super Bot 的确认动作还需要 Task/Result 版本、已核对文件和人工验收状态。若用轮次尾卡，应从自己的持久事件投影这些事实，沿用成果直达校验。相比复用现有最终回复核对，这个选项减少模型转述依赖，需要额外的持久事件与 Web 兼容性验收。[DSH 收敛后文件交付](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-catalog#present) · [DSH 会话投影与折叠契约](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/conversation)
- DF-13 的 QA 续跑于 17:18:09.389 已完成，当时原聊天已到每小时 20 次自动唤醒上限。窗口释放后 17:33:32 才再次自动唤醒，原聊天的 `q-a.txt` 链接于 17:35:11.887 出现。两个复验结果最终都回到了原聊天。已完成即可核对的结果可以探索确定性呈现，减少它对通用模型唤醒额度的依赖。
- DF-12 日常验收后，原聊天派发「DF-14 · 让原聊天交付有可核对的成果回执」。Task `75332887-780e-46bc-9769-22a797d8a3bf`、Run `3c2710ee-7655-4534-9438-f423d6322041`、Worker `session-f7f95da2-5720-4880-bdce-3e3ab38255df`。18:22:14.798 进入原仓库 Worker 会话，原生模型为 Codex GPT-6.2 Sol xhigh。

## 2026-11-21 DF-09 · 受保护的日常重载（Run `5f80e6df-66d6-4c03-b15b-bd3a2c3e9196`）

- **旧命令实测。** 用仓库内合成 home/profile 启动原 `scripts/dev-reload.mjs`，将构建脚本替换为只写入 `built` 的探针。profile 已声明本地 link，用于排除安装分支。两次未启动任何 DSH 进程，均得到 `{"exit":0,"built":true,"patchChanged":true}`，原脚本打印 `Requested native HMR for fixture`。将同一条件写成回归时，原命令以 0 退出，同时写入 `# super-bot-dev-reload: …`。新命令在这个回归中以 1 退出，无构建探针和 patch 变化。[命令级回归](../../../test/adapter/dev-reload.test.ts)
- **接口选择。** 分别检查仓库安装的 DSH `0.2.2-rc.1` 和日常宿主安装的 `0.2.2-rc.5`。两版 launcher 提供 `profileContext.dir/home/name/patchPath` 和 `appReady.onReady`，两版 HMR 均提供 `runExclusive()` 与 `reconcileProfile(requiredIds)`，原生 Plugin Manager 的实时应用路径也使用这对方法。读取 profile 上下文确认目标身份，在同一 HMR 队列中发布已构建的 link 产物并直接重组。`hmr/reload` 是替换之后的通知。简单查一次状态、随后由 CLI 写文件会留下派发竞态。由于两版没有 Super Bot 工作许可接口，用 canonical profile 下仅当前用户可读的发现记录和 loopback 握手传送许可，重组仍由原生服务执行。[rc.1 HMR 声明](https://unpkg.com/@deepseek-ai/dsh-hmr@0.2.2-rc.1/lib/types/index.d.ts) · [rc.5 HMR 声明](https://unpkg.com/@deepseek-ai/dsh-hmr@0.2.2-rc.5/lib/types/index.d.ts)
- **对照取舍。** 采用 OpenClaw 的同一运行宿主预检、关闭新工作入口和区分请求与完成。默认忙碌即拒绝，`--wait 1–120` 只在原实例有界重试，授予后才停止接活。到限、竞争、失联或未知均无强制重载。DS-Bot 用持久版本标记跨实例确认安装，本命令使用同进程一次性交接、旧实例清理完成及新实例的唯一构建标识，以支持同版本热重载。旧实例关闭监听时保留正在发送的回执，卸载清理不会等待该回执。[OpenClaw 安全重启](https://docs.openclaw.ai/cli/gateway/restart-and-supervision#restart-the-gateway) · [DS-Bot 更新实现](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/src/host/update.js)
- **回归覆盖。** `fnm exec --using=24.21.0 node --import tsx --test test/adapter/dev-reload.test.ts` 通过 15 项。覆盖本机握手、缺少宿主、拷贝到其他 profile 的发现记录、错误实例、重复/并发请求、可定位的忙碌输出、等待后获准、未知、Ctrl-C、旧实例失联、原生队列里等待到许可过期、授予后出现新的原生活动、旧实例清理和新实例标识不符、原生需要重启及激活失败。实际账本与适配器回归覆盖双向时序，许可授予后 Worker 派发和 Manager 自动唤醒无法进入，已在途的预检会阻止许可。Task 与 Run 回执、同目录互斥、未收敛占用和 Manager 通知尝试计数由原账本继续约束。构建先暂存，所有合成场景的 manifest 与 patch 均保持原字节。另用实际 esbuild 核对请求 ID 已嵌入 Host 产物且移动后 source map 仍指向源码，用实际 Cordis 核对可选 HMR 服务和 ready 监听装卸，均未启动 DSH 实例。[保护回归](../../../test/adapter/dev-reload.test.ts)
- **适用范围。** 首次安装和旧版启用按已有安装入口进行。本命令要求预先链接本 checkout 的 Web profile、配置原生 HMR 且 `root: []`。两版 DSH 配置 watcher 和 Plugin Manager 仍可自行重组，监测已加载的本地 link 模块在磁盘上的变化。普通构建、手工编辑配置、原生安装与卸载、直接在原生会话投递及外部进程不经过本命令的工作许可。发布后出现原生应用失败或回执失联，CLI 以未确认退出，需查看原生 HMR 诊断。宿主共享模块变更可能要求重启。[启动和首次链接](../../../README.md#本地开发预览) · [原生重组机制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/hmr/README.md)
- **本 Run 全量检查。** `fnm exec --using=24.21.0 env SUPER_BOT_BUILD_OUTDIR=.runtime/df09-check-5f80e6df npm run check` 退出 0，行宽、TypeScript、87 项账本测试、214 项适配测试及 Host/Client 构建通过。构建产物和本地日志留在仓库 `.runtime`，没有覆盖日常宿主加载的 `lib`。`git diff --check` 通过。原工作树 diff 保留。
- **外层 Codex 待复验。** 在现有日常 Web profile 空闲时按既有入口首次启用，再由原 Bot 聊天安排真实 Worker。核对默认拒绝输出包含该活跃任务和 Run，活跃期间观察没有发布。待收敛后核对 `Applied` 的同进程新实例回执，同一原聊天可继续，已有 Task/Run 和人工验收状态可回读。Worker 本 Run 未启动独立 DSH 实例，也未重载日常宿主。DF-09 等待真实 Web 复验与人工确认。

## 2026-11-21 DF-09 · 空闲重载返工（Run `421bf26c-974d-4bd3-8dd1-317997d0ecb0`）

- **真实故障与新回归。** 外层 15:57 的 `.runtime/daily-reload-guard/idle-proof.json` 记录了获取许可、暂存构建及 `unavailable: HMR transactions cannot be nested`。退出码为 1，同一 PID 和插件实例仍在，profile 字节未变。本 Run 先让真实 loopback server 在合成 HMR 的 `AsyncLocalStorage` 事务里启动，再由独立 CLI 进程请求发布。原实现首轮以 1 退出并复现同一错误。修复后连续两次均获得同进程的新实例 `Applied` 回执，旧 watcher 均收敛。[连续重载回归](../../../test/adapter/dev-reload.test.ts)
- **公开接口选择。** rc.1 与 rc.5 的 `watchConfig` 在注册底层文件监听时隔离当前 HMR 事务，并让后续回调进入原生串行事务。HTTP 请求只登记同一实例的有效许可，并写一个仅该实例使用的私有触发文件。回调复核请求、断连、许可期限、profile 与活动状态，再发布暂存产物并直接 `reconcileProfile(['super-bot'])`。监听就绪后才公开本机发现记录。直接调用 `runExclusive()` 需要调用者已在干净的异步上下文，普通 Promise 或定时器延迟仍继承当前上下文。改 profile patch 会触发通用配置重组，无法把发布前的许可复核放进同一专用回调。`hmr/reload` 只报告替换后的结果。实现只使用公开接口。[rc.1 HMR 声明](https://unpkg.com/@deepseek-ai/dsh-hmr@0.2.2-rc.1/lib/types/index.d.ts) · [rc.5 HMR 声明](https://unpkg.com/@deepseek-ai/dsh-hmr@0.2.2-rc.5/lib/types/index.d.ts)
- **取消和卸载。** 失联、取消、过期或旧实例卸载会在发布前撤销排队请求并结束等待。迟到的监听回调无权发布。触发丢失时由租约到期解除门槛。替换期间发起关闭旧 watcher，但卸载清理不等待正在触发卸载的 watcher 回调或 HTTP 回执。新实例仍需匹配本次构建和旧实例清理证明。默认忙碌拒绝，`--wait` 仅有界重试，授予后才暂停新派发和自动唤醒。[许可与发布](../../../src/dev-reload-host.ts) · [开发命令说明](../../../README.md#本地开发预览)
- **本 Run 检查。** 使用实际安装的 rc.1 与 rc.5 HMR 服务，在合成 Cordis 容器中分别于一个原生事务内注册 `watchConfig`，并验证磁盘事件触发了新事务。探针不加载 DSH profile 或启动 DSH 应用。定向回归 18 项通过，保留首次无宿主拒绝、绑定、并发、Worker/Manager 双向竞态、资源占用和回执回归，新增事务内启动、排队取消与触发丢失。`SUPER_BOT_BUILD_OUTDIR=.runtime/df09-check-421bf26c npm run check` 在 Node 24.21.0 下退出 0，含 87 项核心、217 项适配、行宽、类型和 Host/Client 构建。`git diff --check` 通过。
- **外层 Codex 待复验。** 已记录原日常 Web 的真实忙碌拒绝及原 Worker 正常结束。外层在该宿主空闲时按已有入口加载本次修复，再执行受保护命令，核对同 PID 的新实例回执及原聊天、Task/Run 连续性。Worker 保留原工作树 diff，未发布到日常宿主使用的 `lib`，未重载日常宿主。DF-09 保留人工验收。

## 2026-11-21 DF-10 · 在任务详情核对并继续

- **本 Run 的红灯和修复。** 在 Run `4002fd46-9b28-499b-b04f-460fc66ace16` 先用 SQLite 夹具跑插件实际注册的 `POST /api/super-bot` → `run.recover`。夹具已有正常收敛的 ready 和人工待验收成果，没有打开的恢复事项。修复前连续两次退出 1，命令返回 `ok: true`，`lifecycle: review`，`controlMode: paused`，断言得到 `'paused' !== 'auto'`。修复后返回 `recovery-stale`，保留原任务版本、`review`/`auto` 与成果，逐表比较 Task、Binding、Run、资源、Input、Outbox、Attention、请求回执、事件、Result 和 Review 完全一致，解析会话次数为零。原始红灯保存在仓库 `.runtime/df10-red.log`。最终夹具还用实际 DSH Connection rc.1 做 owner 路由与权限验证。[命令回归](../../../test/adapter/df10-recovery.test.ts)
- **详情与原生事实。** 日常安装的 DSH `0.2.2-rc.5` 的 `resolveAgent` 会恢复未加载的会话。详情改用已挂载 `agents.get/list` 和按 owner 过滤的 `jobs.list`。未加载的 Worker 状态和队列标为待确认，已登记的 Job 可单独显示。只列当前绑定、可证实归属的子 Agent 和 Job。展示下一轮/下一步的用户、任务、作业结果、子 Agent 结果及其他输入类别。轮询回归检查零 `resolveAgent`、零投递、零删除、账本逐表相同。原会话入口仍用原生导航。[宿主适配](../../../src/dsh.ts) · [恢复面板](../../../src/ui/work/RecoveryPanel.tsx)
- **终态通知取舍。** rc.1 和 rc.5 的 `tool-jobs` 在 `source` 中提供 `kind: tool-jobs`、`form: notice` 和摘要。正文可能内联实际输出。队列条目没有稳定的 Job ID 可与旧 Run、终态或消费回执逐条核对，放行后新 Run 可能把旧结果当成自己的工作证据。本轮保留通知与用户消息，待用户在原会话处理后使用最新任务版本。回归把含输出的通知放进原生 `next-step`，验证操作拒绝、原内容不变，模拟原生消费后才成功继续。已有恢复加载逻辑只定向移除旧 Run 的完全匹配任务输入。账本作废旧的未知投递记录并拒绝把已有投递身份的待处理输入交给新 Run。[输入及权限回归](../../../test/adapter/df10-recovery.test.ts)
- **显式授权与收敛。** 用户勾选检查确认后可以「仅核对并保持暂停」，或对具备当前绑定的未完成任务点「核对并继续」。后者在 owner 命令中核对当前 Bot 对话归属（从 Bot 工作栏进入时）、任务版本、打开的恢复事项和绑定 ID/代数。会话解析和原生子树检查后复核账本与归属。活动 Worker、待处理输入、活动 Job、驻留子树以及不可确认的宿主状态均保留占用。子树显式检查使用原生 `waitForTreeWork`/`waitForChildren`，可观察没有可列 Agent 的派生和外部工作。只有原生已清静的检查才立即通过，正在等待或检查失败时提示重试。旧 Run 的收敛证据、结果和旧验收状态均按原记录保留。[账本命令](../../../src/store.ts) · [产品入口](../../../src/index.ts)
- **一次新 Run。** 确认旧恢复事项与同 Task 新 Run 的资源占用、审计、回执在同一 SQLite 事务。名额不足整笔回滚。重复请求返回同一 Run 的当前状态，异参同键、不同键竞争、过期版本和人工接管均经过入口测试。新 Run 一次投递，详情回读 `queued`，原生输入进入后回读 `running`。投递回执不确定时同一新 Run 转 `interrupted` 并保留占用。没有第二次投递或凭空补成功。正常停止、回答、返工、备份恢复、交付和人工验收仍由全量回归覆盖。[命令回归](../../../test/adapter/df10-recovery.test.ts)
- **本地检查与外层活验。** Node `24.21.0` 下使用 `SUPER_BOT_BUILD_OUTDIR=.runtime/df10-check fnm exec --using=24.21.0 npm run check`。行宽、TypeScript、87 项核心、228 项适配（含 11 项 DF-10 命令回归）和 Host/Client 构建通过，日志在 `.runtime/df10-check.log`。共享 `lib/index.js`、`lib/client.js` 的 SHA-256 与检查前一致。本 Run 仅用真实 Connection/RPC 路由、真实产品账本与合成宿主状态验证，未启动替代宿主。外层待在日常 Web 空闲时加载，点击确认冷详情轮询、原生 Job 结果保留并可处理、核对两种按钮及新 Run 的状态和归属。保留人工验收。
- 外层使用日常宿主 `0.2.2-rc.5` 的 TypeScript 声明独立核对。候选在 `src/dsh.ts` 两处直接读 `AgentRegistry.isOwnedBy`，rc.5 类型不再声明该属性，生产源码检查出现两处 `TS2339`。保留日常实例，先让原任务返工兼容可选的旧归属方法和 rc.5 子树服务，两套声明均通过后再活验恢复。
- **宿主兼容返工（Run `29e134c0-2a0b-4601-8903-9b9bcce2c654`）。** 先用 `.runtime/daily-recovery/rc5-check.4gIQzF` 中的真实 rc.5 模块重新编译，退出 2，两处 `TS2339` 见 `.runtime/df10-rc5-typecheck-red.log`。新增实际 `task.detail` 命令回归，夹具省略 `AgentRegistry.isOwnedBy`。修复前，一个 `rootOf` 归属查询失败就掩盖后续已知子孙，测试退出 1。修复后，恢复详情和原有执行检查共用可选的旧归属接口类型。rc.1 仍逐级遍历原生直接归属，rc.5 逐个查询原生 `rootOf`，显示可确定的 Worker 子孙和对应 Job，排除其他树和未确认条目。只剩未知条目时显示待确认。回归还验证轮询没有解析会话、启动子树等待、投递、移除输入或改账。实际 rc.5 生产源码 `tsc -p .runtime/daily-recovery/rc5-check.4gIQzF/tsconfig.json` 退出 0，副本与当前 `src` 逐文件一致。[兼容实现](../../../src/dsh.ts) · [命令入口归属回归](../../../test/adapter/df10-recovery.test.ts)
- **返工验证。** Node `24.21.0` 下 `SUPER_BOT_BUILD_OUTDIR=.runtime/df10-rc5-check fnm exec --using=24.21.0 npm run check` 退出 0。行宽、类型、87 项核心、229 项适配（12 项 DF-10 入口回归）和独立 Host/Client 构建通过。完整日志 `.runtime/df10-rc5-check.log`，新回归红灯 `.runtime/df10-rc5-polling-red.log`。`git diff --check` 通过，共享 Host/Client 的 SHA-256 与返工前一致。外层仍需在日常 Web 实例加载并点击核对流程，保留人工验收。
- 外层独立核对同一份生产源码通过真实 rc.5 声明。`npm run dev:reload -- --wait 60` 在兼容返工仍占用仓库时提示等待。原生 Worker 轮次于 16:43:32 结束后命令获准，构建 `470e249f-9f07-4677-9173-e439ee4c9a7e` 应用于同一日常 Web 进程 PID `92961`，实例由 `f91e978a-068f-444d-a0c1-57622b58a6cb` 更新为 `e8b1c995-8d46-4458-a497-ca14775a4a0b`。原聊天和 A/B 待验收状态继续可见。
- **真实 Job 阻塞。** 通过原聊天派发新的 DF-10 活验，Task `d69a96ca-63b3-4ae1-81c5-2230fc2f847d`、第一 Run `3abb3aae-69f0-4db0-ac71-2060fec0b32e`、原生 Worker `session-045e81e0-9c71-4958-b752-e914d7f8d8a7`，请求确定为 Codex GPT-6.2 Sol xhigh。Job `bash-1db179075a6e4422` 于 16:45:20.799 登记。原生 DSH 停止按钮令 Worker 当前轮次于 16:45:39.249 以 aborted 结束，Job 继续运行。原聊天右栏显示任务「待核对」，Recovery 面板显示同一原生 Job「运行中」。即使勾选确认，「核对并继续」仍禁用，操作未提交。画面 `.runtime/daily-recovery/blocked-live-job.jpg`。
- 16:46:40.849 原生 Job 自然结束。其结果通知独立唤醒 Worker 的第二轮，16:46:50.297 正常结束，轮次内无任务输入、报告或执行工具。右栏随后显示「Worker 空闲」「待处理输入 无」「原生 Job 已完成」。核对 checkpoint 与 Job 结果文件后显式确认并点击一次「核对并继续」。同一任务、同一 Worker 会话中，唯一新 Run `01984854-44b9-43b2-81dc-91f978851721` 的原生输入于 16:47:07.670 进入第三轮，实际模型仍为 Codex GPT-6.2 Sol xhigh。
- 活验中的文案发现。Job 已完成后，面板顶部继续展示旧 Run 原因「后台工作尚未停止」，与下方实时「原生 Job 已完成」容易混读。两条记录均有核对价值，后续可为旧原因加「上次中断原因」的明确标签。
- 新轮次核对了原文件后写入一次 `final.txt`，只有一次 ready；16:47:47.125 接受成果 `704709c4-f741-4ad7-9730-a365577ebcf6`，16:47:47.228 原生轮次正常结束。右栏显示「待验收」，审计有「用户完成恢复核对」「已接收执行请求」「任务输入已进入模型上下文」「执行已收敛」。仅有两条归属同一 Task 的原生任务输入，作业通知独占第二轮，旧后台 Job 只启动一次。脱敏事件和三个文件标记在 `.runtime/daily-recovery/live-proof.json`。重复请求、版本与权限错误、仅核对保持暂停、冷会话详情不加载由自动化覆盖。
- 同一 Bot 原聊天也交付了 `checkpoint.txt`、`job-ended.txt`、`final.txt` 的成果链接。保留人工验收。续跑成果画面 `.runtime/daily-recovery/resumed-ready.jpg`。

## 2026-11-21 DF-13 · 排队与重复通知（Run `31f5c3dc-90cb-4bc3-a70f-d62a5c109d5c`）

- 外层在 Worker 17:09:08.497 正常结束后，通过同一个日常 profile 的受保护热载应用构建 `837fdd53-930d-4889-9fd2-f9039f87b906`。宿主 PID 保持 `92961`，插件实例从 `e8b1c995-8d46-4458-a497-ca14775a4a0b` 更新至 `604917c3-4d1a-4c09-8066-e208df1eae8f`。早前两次等待均止于许可前，原实例保持活跃。
- **独立交付活验。** 从同一原聊天按顺序安排 H、QA、QB、I。H 持有父目录，QA、QB 同时因两个子目录真实冲突收到排队回执，I 使用无重叠的目录。QA 详情顶部显示「排队中」、具体的 H 持有方、何时由 Bot 接续，并且不显示「开始执行」；列表行仍显示较宽泛的「待安排」。I 于 17:11:43.116 完成，17:11:43.239 的结算通知唤醒原聊天，17:12:19.449 可见成果链接 `independent.txt`。此时 H 执行中、QA/QB 排队。H 至 17:13:47.712 才结束，两个子任务均在 H 之后开始。区分目录等待与原聊天交付的画面在 `.runtime/daily-queue-recheck/queued-fixed.jpg` 和 `.runtime/daily-queue-recheck/independent-while-blocked.jpg`。
- **重复提醒活验。** H 正常收敛后，17:13:48.449 的 QA 容量通知唤醒同一原聊天的第 41 轮。该轮同时派发 QA（Run `16d11f5c-a354-45aa-bdbc-815150519f84`）与 QB（Run `29eecfe8-9487-4abc-a5c9-e08d4794f395`）。QB 原本排队、随后由 QA 轮次一并启动，其旧容量项未另行唤醒 Manager。QA、QB 各收到一次原生结算通知，17:14:59.411 与 17:15:08.769 各自动展示一条带自身 `attentionId` 的问题。四个 Worker 均观察到 Codex GPT-6.2 Sol xhigh 实际请求。脱敏记录 `.runtime/daily-queue-recheck/proof.json` 断言独立链接唯一且比 H 结束早 88.263 秒、QA/QB 均在目录释放后启动、同一轮派发以及问题各一次。
- **回复接续。** 原聊天先回答 QB。QA 的回答在 Manager 忙碌期间用原生「Queue message」排入下一轮。两条回复各归原问题，实际 Worker 分别只收到 `QA_RECOVERED` 与 `QB_RECOVERED`，各自只产生一个新 Run 和一个正确文件，均进入人工待验收。脱敏记录 `.runtime/daily-queue-recheck/followup-proof.json`。
- 实测路径来自本页「日常聊天并行与交错回复」。用实际 `Managers.pump`、SQLite、管理工具和 Worker 报告入口重放，原生消息与轮次使用确定性夹具。修复前定向命令退出 1，4 项见红。1 条目录等待、12 条目录等待、12 条名额等待分别使独立 `settled` 事件零次唤醒。A 容量轮次内派发 A、B 后，B 的旧容量意图和新结算各进入一次原生 Manager 轮次，两次回复使用同一 `attentionId`。中间验证中，三个阻塞场景先转绿，重复路径仍检出旧意图留在账本。最终 4 项均通过。[调度入口回归](../../../test/adapter/p2.test.ts) · [红灯](../../../.runtime/df13-31f5c3dc/red.log) · [中间验证](../../../.runtime/df13-31f5c3dc/selection.log) · [最终定向日志](../../../.runtime/df13-31f5c3dc/focused.log)
- 通知按既有优先级、创建时间和 ID 选第一条到期且可处理的通知，越过任意数量受阻的容量项。原生会话解析或交付核对结束后重新选取。同目录及嵌套目录 FIFO 仍由同一目录和全局名额准入裁决，回归确认即使有空闲全局名额，后到 B 也必须等 A 释放。选取校验任务所属 Bot。每条补交付在唤醒前核对自己的持久回执，即使它之前已经排在最近 50 条之外。原生 Manager 归属、每 Bot 串行、全局 Worker 名额、热载门槛及唤醒额度由现有入口继续强制，全量检查覆盖权限撤回和双向热载竞争。[通知选择与账本](../../../src/store.ts) · [Manager 唤醒](../../../src/manager.ts)
- Worker 入队成功时，同一账本事务关闭该任务在派发版本及以前、保留零投递尝试且无原生消息身份的容量意图，并记录兑现 Run。已发送或回执未知的 Manager 输入继续按原生持久记录核对。旧账本只有可归属的 Worker 回执和严格先后证据才补记兑现，同时间戳且无派发版本的旧记录保留。测试确认 B 的旧意图关闭、原结算只自动展示一次、显式详情仍能查询真实待答问题、新 Run 的新问题正常通知。另覆盖未完成交付、未知 Worker 投递保留占用与恢复通知、显式继续只有一个新 Run，以及旧版重开保留未知和后续意图。失败报告和未发送 Manager 通知的显式重试由全量回归覆盖。[处理回执](../../../src/store.ts) · [入口回归](../../../test/adapter/p2.test.ts)
- 抽屉顶部显示「排队中」、目录占用方或执行名额。资源已就绪并有活跃的自动排队意图时，提示等管理会话接续。主按钮与高级控制共用同一派发条件，资源可用且没有自动接续时提供手动开始。按实际账本状态验证目录、名额、等待 Manager 和手动入口四种组件表现。[任务详情](../../../src/ui/work/TaskDetail.tsx) · [界面回归](../../../test/adapter/work-view.test.ts)
- 参考 OpenClaw 分开管理会话串行和全局容量，并保留排队输入的来源权限。参考 Argo 以冲突资源维护队序、明确持有方。采用现有 Outbox 的就绪选择和已证实派发后的账本兑现，保留 Manager 对上下文、权限和工作范围的核对。固定扩大队首窗口只会挪动阻塞阈值。直接由调度器启动 Worker 可以省一次 Manager 唤醒，但需要给持久意图增加权限、版本及宿主准入重验；仅按 `attentionId` 过滤文案仍会留下无效唤醒。 [OpenClaw 命令队列](https://docs.openclaw.ai/concepts/queue) · [Argo 同步和锁队列](https://argo-workflows.readthedocs.io/en/latest/synchronization/#queuing)
- Node `24.22.1` 下 `SUPER_BOT_BUILD_OUTDIR=.runtime/df13-31f5c3dc/check npm run check` 退出 0。行宽、TypeScript、87 项核心、239 项适配（其中 DF-13 定向 10 项）和 Host/Client 构建通过。对 41 个逐文件一致的生产文件独立使用日常安装的 24 个 `0.2.2-rc.5` SDK 包做 `tsc --noEmit` 核对，退出 0。原有未提交改动按本轮起始文件和补丁核对，构建与日志均在本仓库 `.runtime/df13-31f5c3dc`。本轮证据为确定性入口与组件检查，日常宿主和浏览器复验由外层在原聊天安排，保留人工验收。[完整检查](../../../.runtime/df13-31f5c3dc/check.log) · [rc.5 检查](../../../.runtime/df13-31f5c3dc/rc5-typecheck.log) · [工作树核对](../../../.runtime/df13-31f5c3dc/worktree.log)

## 2026-11-21 DF-11 · 显示实际模型与来源

- **日常浏览器活验。** Worker 于 17:41:41.911 正常结束。同一日常 Web 受保护热载先等 Manager 交付收敛，再应用构建 `1deef1d3-c233-487d-a96d-c3cc6a5edb56`。PID 保持 `92961`，实例由 `604917c3-4d1a-4c09-8066-e208df1eae8f` 更新为 `cbdd10a9-baf4-4ff6-8be5-784a301dfb89`。直接在原聊天旁打开 A/B 四条历史 Run。续跑 A/B 的原生证据分别展示第 2 轮 `assistant/message #48` 与 `#66`，各自引用所属会话的 `request/header #18`，实际 `magpie-responses / codex/gpt-6.2-sol`、`xhigh`。两次早期 Run 另按各自 Run 和会话展示首轮回复 #20。旧 Run 的派发预计均为未知，保留独立显示。画面在 `.runtime/daily-model-recheck/a-native-model.jpg`。
- **日常聊天活验。** 原聊天原生第 53 轮只调用一次 `model-preview`，返回提供方 `magpie-responses`、模型 `codex/gpt-6.2-sol`、档位 `xhigh`、来源 Worker 角色覆盖（`role-override`），当前 Worker 原生选择为 null。聊天原样展示四项，未派发任务。真正派发 DF-12 时，Manager 在 `create` 前再次调用 `model-preview`，新 Worker 首个原生请求与预计同模型同档位。检查记录 `.runtime/daily-model-recheck/preview-proof.json`，旧记录与新请求均归属同一日常宿主。
- **本次尝试。** 日常 DSH 从原 Super Bot 聊天派发 Run `b3405d7c-1086-4c70-90b3-477af1a1e709`，其原生首个请求记录 `magpie-responses`、`codex/gpt-6.2-sol`、`xhigh`。本轮亲自实现、测试及审查侧栏。启动时已有 42 项工作树记录，已有修改和暂存区保留；期间外层追加的证据也保留。[日常派发证据](#df-11--模型选择与实际调用的证据边界)
- **派发前。** 原聊天的 `super_bot_manage` 增加只读 `model-preview`，新任务无需 ID，已有任务必须归属当前 Bot。Bot 的指令要求在自动建任务或派发前告知预计 provider、model、档位和来源。预计按 Worker 角色覆盖、Worker 原生会话选择、同 Bot 的当前管理会话已记录选择依次确定。无可核实的选择时显示未知。手动开始和显式恢复继续接受 Worker 原生选择或角色覆盖，Bot 会话继承仅用于 Bot 派发。Run 预留事务记录当时预计，重复回执和热载保留该值。[聊天派发](../../../src/manager.ts) · [适配入口](../../../src/dsh.ts) · [账本](../../../src/store.ts)
- **实际请求。** 详情分别呈现下一次预计、Worker 当前原生选择、本次及历史 Run。每个 Run 读取自身 Session，核对消息 ID 和原生来源的 Task、Run、Input、目标版本和绑定代数，再检查 turn、step 及适用的账本坐标。以 `assistant/message` 或带回复信号的 `assistant/attempt` 为调用证据，匹配当时同会话有效 header。仅有 header、缺凭证等本地错误、无可归属输入或不明确的轮次显示未知。档位缺省、回复的路由与 header 不符时，档位显示未知。多个调用按原生顺序显示，原生证据可见会话、轮次、步骤和事件序号。模型标识是 DSH 所见路由，网关背后的供应商版本未知。[原生取证](../../../src/dsh-model.ts) · [侧栏显示](../../../src/ui/work/ModelDetails.tsx)
- **原生复核。** 仓库 SDK 为 rc.1，日常 3080 宿主的安装为 rc.5。两版 `dsh-agent-loop` 的 `step`、`prepareRequest` 和 `buildRequest` 均先处理选模与准备，随后在实际步骤中写入输入与 header，开始流后才可能生成助手回复或尝试。`modelSelection.next` 反映原生已记录的下一请求选择，适配器默认档位在当前选择中可能省略；已证实出站请求的有效档位取自 header。持久层 `open(id, 'read')` 不取得写所有权，详情仅查已驻留 Agent 和持久日志。日常 A、B 的第二轮分别用各自 `assistant/message #48`、`#66` 引用各自会话的 `request/header #18`，两轮新增 header 数均为零，档位均为 xhigh。[日常 A/B 脱敏坐标](../../../.runtime/daily-model-recheck/native-baseline.json)
- **先红后绿。** 实际 `/api/super-bot` 详情先有两项红灯，实际注册的 `super_bot_manage` 预览有一项红灯。最终四项通过，覆盖无新 header 的同模型续跑、轮内切换和未知档位、请求前失败及只有错误的尝试、输出型重试、无法归属与可以精确归属的旧 Run、两 Bot/Session、派发与重复回执、重开插件和更换角色配置、详情轮询零 `resolveAgent`。测试使用真实插件路由、账本、DSH Session 日志与原生选模投影，持久读句柄与 Agent 活动由本地夹具提供。[回归源码](../../../test/adapter/df11-model.test.ts) · [详情红灯](../../../.runtime/df11-b3405d7c/red-detail.log) · [聊天红灯](../../../.runtime/df11-b3405d7c/red-chat.log) · [完整检查](../../../.runtime/df11-b3405d7c/check.log)
- **产品取舍。** DS-Bot 让每个 Bot 有独立模型选择，并能回落到上次可用模型或重新提示。Super Bot 保留 DSH 原生选择入口，把 Worker 覆盖和继承来源带进任务。OpenClaw 会话状态区分当前会话覆盖、配置默认与会话记录所见的模型，Super Bot 将已证实的模型定位到每个 Run 和步骤。Grok Bot 为用户自动路由，企业推理钩子则按请求关联会话与模型。Super Bot 借鉴审计的关联方式，在任务内展示宿主可证实的路由与原生事件坐标，保留用户对模型和档位的选择。[DS-Bot 模型](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/README.md#models) · [OpenClaw 状态](https://docs.openclaw.ai/cli/status) · [Grok Bot 模型选择](https://docs.x.ai/grok-bot/faq) · [Grok Bot 推理审计](https://docs.x.ai/grok-bot/inference-hooks)
- **交付边界。** Node `24.22.1`，`SUPER_BOT_BUILD_OUTDIR=.runtime/df11-b3405d7c/build npm run check` 退出 0。行宽、rc.1 类型检查、87 项核心和 243 项适配，以及独立 Host/Client 构建均通过。逐文件一致的生产源码用实际日常 rc.5 SDK 运行 `tsc --noEmit`，同一 SDK 的 4 项定向入口回归通过。侧栏使用现有组件与主题，已由本 Worker 审查源码和入口回归。日常 profile、共享发布目录和运行实例未修改。新版日常浏览器呈现和受保护热载、A/B 两项历史的现场核对由用户完成，保持人工验收。[rc.5 检查](../../../.runtime/df11-b3405d7c/rc5-typecheck.log) · [Host 构建](../../../.runtime/df11-b3405d7c/build/index.js) · [Client 构建](../../../.runtime/df11-b3405d7c/build/client.js)

## 2026-11-21 DF-12 · 显示实际的子 Agent 等待与收敛

- **日常 DSH 活验。** 编码 Worker 于 18:09:30.601 完成。受保护热载在同一 Web 宿主 PID `92961` 应用构建 `c323272b-c080-462c-befb-95ca09713746`，实例由 `cbdd10a9-baf4-4ff6-8be5-784a301dfb89` 更新为 `42ddbca0-cfb4-4d3f-a70c-88a59b47426c`。原聊天派发 Task `43998b3b-6950-4206-ad3b-0307837eca8e`。第一轮显式传入子模型字段，被日常宿主拒绝。原聊天回答当前问题并续跑同一父会话，两个原生 fork 省略三个模型覆盖参数，由宿主继承。父 Worker 和两个子 Agent 的原生请求均为 `magpie-responses / codex/gpt-6.2-sol`、`xhigh`。原生日志的 fork 历史可包含复制的父轮次，活验按实际父会话身份及本轮起点选取子会话自己的原生记录。
- **父 Run 收敛顺序。** 在 Run `955e4ff9-c553-497a-bf81-71df204296c1` 的原生第 2 轮，两个子会话于 18:16:26.397 和 18:16:26.422 开始。父首次 `ready` 发生在 18:16:34.698。子 A、B 分别于 18:17:55.798、18:18:36.569 结束，首次调用直到 18:18:36.585 才返回 `accepted:false`、`subtree-joined`。父同轮核对三份文件，18:19:00.702 第二次 `ready` 获接纳，18:19:00.759 结束，成果 `d802487a-5d40-4944-aa05-a60fdb76ae82` 保留待人工验收。两份子文件分别由两个子原生会话写入，三份标记内容通过独立核对。[原生事件精简证据](../../../.runtime/daily-child-wait/df12-native-proof.json)
- **日常 Web 详情。** 同一等待区在 39 秒显示已知 2 个，1 分 11 秒仍持续计时，在 1 分 35 秒显示已知 1 个并标记 A 已结束。第二个子会话结束后，实时卡收起，同一 Run 的历史显示第 2 轮、总用时 2 分 1 秒和两个子会话结局。通过 A 的入口打开真实原生会话并见到 `DF12_CHILD_A`。回到原聊天重新打开详情，收敛历史与三份成果入口仍在，状态保持人工待验收。在原聊天的正文中也看到三份成果链接。[等待 2 个](../../../.runtime/daily-child-wait/df12-wait-two.jpg) · [等待 1 个](../../../.runtime/daily-child-wait/df12-wait-one.jpg) · [收敛历史](../../../.runtime/daily-child-wait/df12-history.jpg)
- **排队观察。** 本轮第一个活验请求进入日常原聊天的原生发送队列。之前的交付轮次发生 36.240 秒的上下文压缩，随后完成交付。活验消息在下一轮于 18:11:38.602 入场，Worker 到 18:13:16.405 启动。长对话下，交付与新指令共享 Manager 的串行轮次，会把上下文压缩和工具核对时间一并反映到派发等待。后续用 DF-14 区分可由宿主核对的交付与需要 Manager 推理的工作。
- 本次由日常 Super Bot 派发的 Full Access Worker 在原仓库执行，Run `fc9cd6b9-cc4d-4521-9e76-276f67e51232`。工作树和暂存区在动手前保存基线。任务项保留人工验收。[工作树与产物校验](../../../.runtime/df12-fc9cd6b9/worktree.log)
- 先在实际注册的 `super_bot_report` 和 `agent/turn-stopping` 进入等待，再用实际 `/api/super-bot` 的 `task.detail` 读取。两版契约共四项断言先失败，等待已调用原生树服务但详情缺字段。接入后十项 DF-12 入口回归通过。测试使用实际 Cordis scoped dispatch、原生 Session、Host Connection、插件入口和磁盘 SQLite。Worker 驱动与子树服务的时序由确定性夹具控制。[入口回归](../../../test/adapter/df12-child-wait.test.ts) · [红灯](../../../.runtime/df12-fc9cd6b9/red-entrypoints.log) · [绿灯](../../../.runtime/df12-fc9cd6b9/green-entrypoints.log)
- rc.1 用直接委派者作为 carrier，发现已在册子会话时可用 `agents.isOwnedBy` 核对，`waitForChildren` 等待该委派树。rc.5 以运行树根为 carrier，payload 的 `parentSessionId` 记录直接创建者，`rootOf` 核对已驻留身份，`waitForTreeWork` 以真实树根执行。两版 `subagent/start` 和 `subagent/end` 用同一个原生激活 ID 配对。插件依赖宿主共享的 `dsh-scope` 读取 Cordis 实际绑定的 carrier。归属还要求 Worker 的原生 Session 实例，以及精确输入身份、任务版本、绑定代数和同轮序号。错误 carrier、创建者、子 ID、provider、其他轮次和重复或晚到结局均有回归。[rc.1 服务契约](https://unpkg.com/@deepseek-ai/dsh-subagent@0.2.2-rc.1/lib/types/index.d.ts) · [rc.5 服务契约](https://unpkg.com/@deepseek-ai/dsh-subagent@0.2.2-rc.5/lib/types/index.d.ts) · [DSH 链接依赖规则](https://deepseek-harness.github.io/deepseek-harness/en/user/develop/basic/publish) · [归属实现](../../../src/dsh.ts)
- 任务详情按所属 Run 读取等待记录。两版均核对 0 秒时有 2 个已知子执行，12 秒时剩 1 个，37 秒时保留一次结束和固定时长。等待数是已观察到尚未结束的激活数，完整数量可能包含尚未发布的工作或其他未观测成员。只有已归属的本地发布事件可生成 DSH 原生子会话地址，由宿主解析会话模式。外部激活可记录结局。快速返回空闲不新增等待记录。断开再读取得宿主账本事实，重载前已经结束的历史保持原值。中途重载仍保留已知起点和子执行，结束与总用时可以是未知。已取消的等待单独呈现，迟到的子结局不会被写进旧等待，也不进入复用同一 Worker 的新 Run。[账本](../../../src/store.ts) · [等待记录](../../../src/dsh-child-wait.ts) · [侧栏展示](../../../src/ui/work/ChildWaits.tsx) · [原生会话导航](../../../src/client.tsx)
- OpenClaw 的当前状态按运行、等待子 Agent、审批和结算待交付等来源区分，保留子任务时间和历史定位。Grok Bot 侧栏单独提示问题、审批或交接等需要用户的事项。Super Bot 复用宿主实际等待和原有审批、恢复入口。日常子树等待使用普通进度区，恢复核对仍显示在需要用户处理处。`ready` 续轮、后台 Job 和目录占用、停止、旧候选与人工验收继续由既有收敛路径决定。原生等待收敛只说明这次等待返回，报告及验收仍由原流程处理。[OpenClaw 子 Agent 状态](https://docs.openclaw.ai/tools/subagents/slash-command) · [Grok Bot 注意状态](https://docs.x.ai/grok-bot/settings-and-notifications) · [收敛回归](../../../test/adapter/subtree-ready.test.ts)
- Node `24.22.1` 下完整 `SUPER_BOT_BUILD_OUTDIR=.runtime/df12-fc9cd6b9/build npm run check` 退出 0。行宽、rc.1 类型、87 核心、253 适配和 Host/Client 构建通过。独立源码副本解析到日常安装的 27 个 rc.5 SDK 包，生产源码类型检查及 68 项定向回归通过。客户端测试核对传给原生 Workspace 的子会话地址，侧栏源码使用现有组件与主题。共享构建产物用 SHA-256 核对，日常 profile 和活插件保持原实例。日常 Web 热载、浏览器显示、点击子会话及真实模型子 Agent 的等待和收敛由用户现场复验。[完整检查](../../../.runtime/df12-fc9cd6b9/check.log) · [实际 rc.5 检查](../../../.runtime/df12-fc9cd6b9/rc5.log) · [Host 构建](../../../.runtime/df12-fc9cd6b9/build/index.js) · [Client 构建](../../../.runtime/df12-fc9cd6b9/build/client.js)

## 2026-11-21 DF-14 · 原聊天成果回执

- **日常 DSH 热载。** 编码 Worker 于 18:53:41.912 正常结束，受保护热载在原日常 Web 宿主 PID `92961` 应用构建 `af550776-0bbf-4a2c-8d8d-ad1762ad5703`，实例由 `42ddbca0-cfb4-4d3f-a70c-88a59b47426c` 更新为 `7417139e-237f-4211-82bf-c1a0b43c52ae`。DF-12 旧成果的 `deliver` 原有记录先显示需核对，原生持久回复被重新核对后显示已确认。三份入口与原等待历史仍可查阅。
- **日常并行交付。** 从原聊天同一轮派发两个独立的 existing 目录。A 的原生轮次从 18:55:04.029 至 18:56:42.042，B 从 18:55:11.155 至 18:55:31.168，重叠 20.013 秒。两个 Worker 均实际使用 Codex GPT-6.2 Sol xhigh，各一次 Run、一次 `deliver`。B 的原聊天回复于 18:56:14.924 持久出现，早于 A 结束 27.118 秒。A 的原聊天回复于 18:57:16.765 出现。最终回复分别进入原生第 64、65 轮，均正常结束。Task、Run、Result、消息和结束序号的对应关系通过原生记录核对。[并行原生事件](../../../.runtime/daily-delivery-recheck/native-proof.json)
- **日常 Web 验收。** A 尚在执行时，B 已可在旁边的工作栏下载，先显示「原聊天交付 · 等待 Bot 检查成果」。原聊天出现可点击入口后，任务详情显示「原聊天交付 · 已确认成果链接」，A 也在自己的交付后显示同样状态。分别点击原聊天的两个精确成果入口，进入各自的 Task/Result 且两项均显示「成果 · 待你验收」。从原聊天实际下载 `delivery-a.md` 与含 Markdown 右方括号的 `delivery-b].md`，内容分别为 `DF14_A`、`DF14_B`。刷新 Web 后从会话列表重新打开原聊天，默认视图中两个文件链接及精确成果链接分别恢复。日常实时验证保留正常限额，已达到上限的漏链情况由双版原生回归复现。[B 成果待交付](../../../.runtime/daily-delivery-recheck/fast-awaits-delivery.jpg) · [B 交付已确认](../../../.runtime/daily-delivery-recheck/fast-confirmed.jpg)
- 日常聊天派发的 Worker 在原仓库执行 Run `3c2710ee-7655-4534-9438-f423d6322041`。最小回归通过实际注册的 `deliver` 处理器和原生轮次适配入口。原始代码在工具回包成功、最终回复缺失链接时已经把义务记为 `done`。隔离原生 rc.5 也从普通对话创建任务，以真实注册工具跑到同一断言，待交付列表中已找不到这项义务。修复后的同一用例先读到 `pending` 和达到每小时一次唤醒限额的诊断。之后在同一原生会话发送一条确定性查阅请求，最终回复含正确工作入口和文件地址。独立认证下载为 HTTP 200，账本只写了一条绑定原生消息和结束序号的回执。重复回复仍为一条回执、一次自动唤醒、一个 Worker Run，`humanAcceptedAt` 为空。[注册入口红灯](../../../.runtime/df14-3c2710ee/red.log) · [最小绿灯](../../../.runtime/df14-3c2710ee/green-minimal.log) · [原生 rc.5 红灯](../../../.runtime/df14-3c2710ee/native-red.log) · [原生 rc.5 绿灯](../../../.runtime/df14-3c2710ee/native-rc5-final.log) · [原生 rc.1 绿灯](../../../.runtime/df14-3c2710ee/native-rc1-final.log)
- `deliver` 只生成 Markdown 并保存命令回执，交付义务由现有 Outbox 保留。原生核对在 `flush` 后读连续持久日志，按当前 Bot、管理会话、任务版本与结果定位登记工具调用或已归属的通知输入。可见最终回复须有正常结束、同宿主的精确任务和成果入口及全部引用文件。每个原生文本块独立解析，避免把代码、图片、外站链接或分散的引用定义当成可点击入口。提交回执前核对当前文件哈希，漂移进入待核对。回执按同一成果幂等提交，人工验收仍由原有命令记录。补交通知提供程序生成的精确链接，已存在的回复由宿主直接核对，模型唤醒只用于仍需生成或转述的内容。原聊天旁「工作」的成果详情提供不消耗模型额度的读取与下载，同时显示待审查、待交付、待核对和已确认的状态。[适配与核对](../../../src/manager.ts) · [链接校验](../../../src/chat-delivery-links.ts) · [交付账本](../../../src/store.ts) · [成果面板](../../../src/ui/work/ResultCard.tsx)
- 回归覆盖工具已回包后的断开、有无持久最终回复的重开、跨 Bot/任务/成果/会话、未知输入和重复回调、有效的 Markdown 文件名、错误 origin、旧结果以及限额。已有原生回执保留。只有历史工具回包的 `done` 在启动核对时转为待核对，保留原始工具数据。旧任务入口仅在历史通知附有同一版本的完整文件链接时兼容。新交付要求版本化入口。旧版本的验收权限和下载哈希校验继续由原有入口控制，文件被覆盖后旧下载拒绝返回新字节。[回归](../../../test/adapter/delivery.test.ts) · [代码块与外站红灯](../../../.runtime/df14-3c2710ee/red-links.log) · [跨文本块红灯](../../../.runtime/df14-3c2710ee/red-text-blocks.log)
- **Web 取舍。** 安装版 rc.1 与日常 rc.5 均有按工具名分派的 `tool.call.toolview` 和可重放的 JSON `tool/result.meta`。两版打包产物都包含完成轮次的过程折叠，默认详细模式也允许隐藏工具所在过程节点。最终助手文本仍走独立回复节点。同宿主 DS-Bot 的交接卡在工具行隐藏时另用输入框上方入口。DSH 自身文件交付另有 `conversation.chat.turnTail`，可考虑为同版本 Super Bot 成果投影一个程序生成的入口，需增加持久投影并完成默认折叠、离开重开和热载的现实点击核对。本轮选择现有持久最终回复与成果面板，回执依据仍是可见回复。参考 OpenClaw 将持久交付队列、发送结果与未知状态分开，参考 Grok Bot 分开展示需处理事项与新成果。[双版 Web 契约核对](../../../.runtime/df14-3c2710ee/web-contract.log) · [DS-Bot 交接卡](https://github.com/Fei2411/DS-Bot/blob/main/ds-bot/src/client/handoff-card.js) · [DSH 工具呈现](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool#web-client-presentation) · [OpenClaw 交付审计](https://docs.openclaw.ai/cli/audit) · [Grok Bot 通知状态](https://docs.x.ai/grok-bot/settings-and-notifications)
- **构建与边界。** Node `24.22.1`。独立副本使用仓库锁文件 `npm ci --ignore-scripts`，`npm run check` 通过行宽、rc.1 类型、87 项核心、268 项适配和 Host/Client 构建。逐文件一致的源码以实际安装的 rc.5 SDK 完成生产类型检查、构建及 129 项定向回归。隔离原生烟测用合成模型、独立 profile 和账本，将 `managerWakesPerHour` 设为 `1` 后运行 `node scripts/smoke-delivery-receipt.mjs <隔离宿主日志>`。新增 `marked` 固定依赖已在隔离安装核对。原仓库暂存指纹和共享构建文件哈希一致，日常宿主仍为原 PID。日常浏览器默认折叠、离开重开、受保护热载后的现实点击与最终验收由用户检查。[全量检查](../../../.runtime/df14-3c2710ee/npm-check-final.log) · [实际 SDK 来源](../../../.runtime/df14-3c2710ee/rc5-sdk.log) · [rc.5 生产核对](../../../.runtime/df14-3c2710ee/rc5-production-final.log) · [rc.5 定向测试](../../../.runtime/df14-3c2710ee/rc5-targeted-final.log) · [工作树与产物](../../../.runtime/df14-3c2710ee/worktree-final.log)

## 2026-11-22 · 同机 Web 与 Desktop 的创建端归属

- Run `2192d5e0-d47b-4552-9758-5e2e1c36a2da` 从日常 Web 原聊天派发，由该 Full Access Worker 在原仓库执行。起点为 `dev` 上的 `4e3daeadc68a1be2c260ec9b3b6c0909f34c44c3`，保存了 34 个已修改文件、17 个未跟踪文件、暂存区清单及共享构建哈希。日常 Web 的 3080 监听 PID 和共享 Host/Client 构建保持一致。构建、配对、合成账本和测试日志均在本仓库 `.runtime`。本轮改动可独立对照起始快照。[本轮差异](../../../.runtime/mirror-2192d5e0/run.patch) · [工作树核对](../../../.runtime/mirror-2192d5e0/worktree.log)
- 本端用原账本和 DSH owner-only 路由。对端查询限定为 Bot 目录、分页任务和按 Bot 核对的任务详情。配对目录和文件需当前 POSIX 用户私有。回环监听核对双方 canonical profile/账本目录的配对证明、角色、实例、时效及请求/应答签名，拒绝重放。DB 侧的归属标记在开库前检查，SQLite schema 保持原版。镜像不向另一端传递原生会话 ID、Bot 指令、参考资料、原始聊天事件、工作目录或附件路径。附带摘要的任务记录按普通文本显示。附件只列数量，创建端使用原认证下载，改变文件后原下载返回 409。[配对和传输](../../../src/mirror-host.ts) · [查询投影](../../../src/mirror-queries.ts) · [启用说明](../../../README.md#同机-web-与-desktop-只读镜像)
- 首次原生红灯在未实现 `mirror.catalog` 时返回未知操作。最终用 Web rc.1、Web rc.5 分别与实际 macOS Desktop rc.5 Host 运行完整检查。Desktop 由已安装 Electron 的 Node 模式执行包内 `@deepseek-ai/dsh-desktop-host/lib/index.js`，使用 Electron 父进程的参数、IPC ready/shutdown 和真实 `--port 0`。Web 启动使用实际 DSH CLI。两端曾在关闭配对时各建已有同名 Bot 和任务，再以原账本启用配对。两端的已有、新建同名 Bot 都通过确定性模型在创建端原生聊天、派发 Worker、记录进度与成果。另一端核对 Bot ID、分页、摘要、验收检查、Bot 审查及人工接受，读不到附件和会话。人工接受由脚本经各自 owner 入口在隔离合成任务完成。Web 的 HTML 启动清单和 Desktop 原生 IPC 注入清单都实际发布本轮 Client，并返回有效客户端资源。[红灯](../../../.runtime/mirror-2192d5e0/red.log) · [原生烟测](../../../scripts/smoke-mirror.mjs) · [rc.1 证据](../../../.runtime/mirror-2192d5e0/release-rc1/proof.json) · [rc.5 证据](../../../.runtime/mirror-2192d5e0/release-rc5/proof.json)
- 两端实际服务器均拒绝未配对查询、缺证明、错密钥、错 profile、错端、旧实例、过期与重放、浏览器跨站头、URL/路径、任意 RPC 和派发、聊天导航、停止、编辑、接受、取消、删除等写动作。用错误 profile 指向 Web 原账本时，在打开 SQLite 前拒绝。`lsof` 验证两份 SQLite 每份仅由对应宿主进程持有。两端在同 PID 完成原生配置热替换，重新读到原 Bot、会话、成果与验收。Desktop 强制退出残留描述符时 Web 正确显示离线，Desktop 的实际载体端口在 rc.5 组合由 `63169` 变为 `63443`。Web 正常退出后 Desktop 同样判为离线。两次断开期间存活宿主均在原账本新建任务，重连后可从另一端核对。旧 Task、Run、Result、acceptance 及账本 inode 一致。模拟错误端点身份时明确返回不可核对。[Web rc.5 日志](../../../.runtime/mirror-2192d5e0/release-rc5.log) · [Web rc.1 日志](../../../.runtime/mirror-2192d5e0/release-rc1.log)
- 最终 Node `24.22.1` 的完整 `npm run check` 退出 0，行宽、类型、87 核心、268 适配和两个构建通过。无配对旧 fixture 的 DF-11 查询仍通过。当前生产源码也用实际 Web rc.5 SDK 完成 `tsc --noEmit`。隔离分发清单检查为 12 项。用户在日常 Web 和 macOS Desktop 实机启用及最终验收。镜像界面复用现有页面的任务查询、筛选与抽屉，隐藏跨端聊天和所有变更入口。Worker 核对了实现与客户端资源，未操作日常浏览器或原生 GUI。DSH 原生全局会话列表仍按宿主规则显示共享 Session。[完整检查](../../../.runtime/mirror-2192d5e0/release-check.log) · [rc.5 类型](../../../.runtime/mirror-2192d5e0/rc5-typecheck.log) · [构建哈希](../../../.runtime/mirror-2192d5e0/release-build.sha) · [分发清单](../../../.runtime/mirror-2192d5e0/pack-check.json)

## 2026-11-22 · 收件箱、任务进度与宿主提示

- Run `93115b9d-8ddd-42a7-9634-0bbdb7b5b479` 从原日常 Web 聊天派发，在已有仓库执行。顶栏与收件箱按当前开放阻塞事项计数，测试任务折叠，交付按原聊天有效回执显示。Worker 进度、程序记录和可归属的开发重载回执各自带时间。实际运行未重载日常宿主。源码、暂存区和共享构建核验见[本轮文件清单](../../../.runtime/inbox-93115b9d/worktree-summary.json)。
- Node `24.22.1` 的全量 `npm run check` 通过行宽、TypeScript、87 项核心、273 项适配及 Host/Client 构建。重载测试使用合成原生 HMR 边界，覆盖源码不匹配和同进程接棒。构建和校验值仅在 `.runtime`。[全量检查](../../../.runtime/inbox-93115b9d/check-final.log) · [构建校验值](../../../.runtime/inbox-93115b9d/build.sha256)
- 现装 Web rc.5 与 macOS Desktop rc.5 原生 Host 在隔离 profile 完成确定性聊天、进度、创建端和双向只读回归。配对缺失、权限和错配降级时本地可写；归属错误拒绝开库。测试关闭 HMR，使用原生载体发布客户端资源并检查认证路径。日常 Web/Desktop 界面和真实回执启用留待人工核对。[烟测日志](../../../.runtime/inbox-93115b9d/native-verified.log) · [隔离证据](../../../.runtime/inbox-93115b9d/native-verified/proof.json)
