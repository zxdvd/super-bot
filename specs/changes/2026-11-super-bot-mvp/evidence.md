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

每个 SB 任务记录：提交/包版本、场景、命令或 UI 操作、实际结果、证据位置、剩余限制。不得只写“测试通过”；Fake 与真实宿主结果分列。T01～T20 当前全部待验证。

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
