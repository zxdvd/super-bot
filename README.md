# Super Bot

与长期存在的 Bot 聊天，把事情交给它，由它安排执行、跟进并回来交付。工作面板用于按需查看进度、成果与需要你处理的事项。

**聊天表达意图；面板展示事实；程序维护状态；模型负责判断。**

当前为本地开发预览：与 Bot 聊天，由它创建任务、委派普通 Full Access Worker、检查成果并回到原对话交付；支持补充需求、同任务返工、停止和人工验收。首个交付形态是 DSH Web 插件，固定验证版本 `0.2.2-rc.1`；Desktop `0.2.1-rc.5` 尚未完成兼容验证。Super Bot 是独立产品，不属于 `dsh-plugins` 搜索插件集合。

**2026-11-09 状态：** 已完成四轮真实 Bot/Worker dogfooding，覆盖代码修复、补充需求、交付、返工、聊天旁工作视图和侧栏整理；最终源码检查 163 项测试及 typecheck/build 通过。真实用户的最终接受、多任务歧义体验和精确费用评估仍待完成。新会话先读 [接手说明](docs/handoff.md)，验收范围见 [任务清单](specs/changes/2026-11-super-bot-mvp/tasks.md)。

## 产品边界

- Bot 是长期身份；Task 是责任对象；Run 是一次尝试；执行 Session 可以替换。
- 默认人工最终验收；Bot 可以检查证据并提出最多两次自动返工。
- 单用户、单宿主、本地 SQLite；多个 Bot、普通原生任务 Session、需要人工处理的事项优先展示。
- 当前以 DSH 提供模型执行、工具、原生聊天与审批。未来可能成为独立 App/Web；本轮不实现第二个运行时、独立服务器或云端部署。

领域逻辑不依赖 DSH `Context`、Session 类型和客户端组件。DSH 是第一个执行适配与产品入口，不是产品身份；独立 App/Web 仍需另行实现宿主、认证、执行适配和数据迁移，不能承诺只换 UI 即完成迁移。

## 源码仓库导航

- [接手说明](docs/handoff.md)：当前环境、已完成工作、异常及下一步。
- [文档目录](docs/README.md)：使用、开发和真实试用记录。
- [实施路线](ROADMAP.md)：阶段目标和退出条件。
- [本轮提案](specs/changes/2026-11-super-bot-mvp/README.md)：范围、验收、依赖与设计决策。
- [聊天主流程](specs/changes/2026-11-super-bot-mvp/06-chat-first.md)：当前产品目标、最小演示与底层复用边界。
- [逐项任务](specs/changes/2026-11-super-bot-mvp/tasks.md)：按可演示闭环推进，每项有验证方法。
- [研究证据](specs/changes/2026-11-super-bot-mvp/evidence.md)：已读源码、本机检查与待验证能力。
- [运行能力与降级](docs/runtime-support.md)：当前支持范围、限制和复验命令。
- [原始设计基线](docs/design-baseline.md)：用户提供的 v0.1 输入快照；后续实现契约以本轮 Spec 为准。
- [协作规则](AGENTS.md)。

## 安装本地预览包

此预览包固定用于 DSH Web `0.2.2-rc.1` 和 Node `>=24.9`。已有兼容 DSH 的用户可直接使用收到的 tgz；尚未安装 DSH 时可运行 `npm install -g @deepseek-ai/dsh@0.2.2-rc.1`。开发者先在源码仓库构建并打包：

```sh
npm ci
npm run check
npm pack
```

用独立数据目录和 profile 安装生成的 `zxdvd-super-bot-0.1.3.tgz`：

```sh
DSH_HOME=/absolute/path/super-bot-home dsh --profile super-bot --from-default-profile web --dump-config > /dev/null
DSH_HOME=/absolute/path/super-bot-home dsh plugin --profile super-bot add /absolute/path/zxdvd-super-bot-0.1.3.tgz
DSH_HOME=/absolute/path/super-bot-home dsh --profile super-bot --no-open --port 3081
```

上面的 `--from-default-profile web` **仅用于全新 profile 的首次初始化**；更新现有 profile 时只运行 plugin add 和启动命令，不要重复初始化。

首次运行保留终端打印的登录链接，打开后进入左侧 Super Bot。独立 home 不继承日常模型账号；在原生会话明确选择并配置你自己的模型。DSH 默认路由不算该会话已选择；未选择时任务不创建 Run，Manager 保留通知且不自动调用。显式选择并不保证账号可用，缺登录/API Key 或额度错误会在工作台提示，再到原生设置处理。产品安装包不包含测试模型。升级前先备份、停止该宿主，再安装新包并启动；不要同时打开同一账本。下方的构建、测试命令只适用于源码仓库，不在已安装的插件目录运行。

## 本地开发预览

开发迭代不需要修改版本号或打 tgz。DSH Web 自带 Host HMR 和 Client HMR，源码以本地 `link:` 安装即可使用；[机制与实际验证](docs/development-hmr.md)。

日常使用已有 `~/.dsh/profiles/web`（保留该 profile 的模型和会话），在 Bot、Worker 都空闲后运行：

```sh
fnm exec --using=24.21.0 npm run dev:reload
```

该命令构建代码，首次将本插件切换为仓库本地链接，然后更新 profile patch 中的一行开发标记，触发 DSH 原生配置重载。仅 `touch` 文件会被 DSH 的内容去重忽略。默认使用运行中的 web profile；可用 `DSH_HOME` 和 `SUPER_BOT_PROFILE` 指定其他现有 profile。宿主需启用原生 HMR（Web 默认配置已启用），执行后检查 Plugins 是否正常激活。它不会替你启动 DSH，也不把“已请求重载”当作激活成功。当前开发模式下不要移动仓库或删除 `lib`。

日常自修改 dogfooding 使用手动重载：Worker 改源码时不自动卸载正在执行的后端。前端构建产物由 DSH Client HMR 自动刷新，页面局部状态可能重置。需要自动监听源码时，使用下面的独立开发宿主：

需要 Node `>=24.9`，当前验证 Node `24.21.0`。在仓库中运行：

```sh
npm ci
npm run check
npm run dev
```

`dev` 使用仓库 `.runtime/dsh-dev` 下的独立 home 和 `super-bot-dev` profile，监听 `127.0.0.1:3081`（可设 `SUPER_BOT_PORT`）。自动构建监听 `src`，Host HMR 监听 `lib/index.js`，Client HMR 刷新 `lib/client.js`；不需要重复打包、安装或重启宿主。从终端启动链接进入后点击左侧 Super Bot。该隔离环境不复用日常会话或模型凭证；有模型的日常入口仍是 web profile。退出用 Ctrl-C；再次运行保留任务数据。数据库默认在 `$DSH_HOME/super-bot/ledger.sqlite`，不要同时用多个宿主打开同一数据库。

- `npm run check`：类型检查、核心账本测试、DSH 适配层测试、Host/Client 构建。`npm test` 单独运行不依赖 DSH 的账本测试。
- `npm run smoke:chat`：在专用探针宿主上验证聊天接单、同对话交付、文件下载、提问回答及返工；仅确定性模型。
- `npm run smoke`：测试宿主运行时检查真实状态、WAL、未认证访问与跨域拒绝。
- `npm pack --dry-run`：核对分发清单；运行数据和契约测试插件不进入安装包。

Node 用 fnm 管理时，可用 `fnm exec --using=24.21.0 npm run dev`，无需改变机器默认版本。完整执行流程和可靠性门槛见任务清单。未启用 Manager 时，创建任务只保存目标，“开始执行”才调用原生会话中选定的模型。启用 Manager 后，完整且未暂停的任务会自动安排执行；需要先核对时，请在创建表单选择“先暂停”。Worker 使用普通 DSH Session。显式配置 `fullAccess: true` 后，使用原生 Full Access 预设和宿主可用工具，包括 Shell、Git 与子 Agent；Super Bot 不再附加工具白名单、目录守卫或执行步数/时长上限。`workspace` 指定项目目录，作为任务资源占用根；全局最多两个未收敛任务，同一项目不能并发派发写入任务。暂停阻止后续派发，停止请求取消并核对收敛。旧 files 模式保留用于兼容和隔离验证：只允许任务目录内 read/write/edit 与报告，每次最多 40 步或 10 分钟，目录变化和预算耗尽转核对。


## 使用完整原生 Worker

在所用 profile 的 `cordis.patch.yml` 为本插件配置角色模型和项目目录，provider/model 填该 profile 中已有的标识：

```yaml
- id: super-bot
  config:
    fullAccess: true
    workspace: /absolute/path/project
    managerModel:
      provider: your-provider
      model: gpt-6.1-sol
      reasoningEffort: medium
    workerModel:
      provider: your-provider
      model: gpt-6.1-sol
      reasoningEffort: xhigh
```

推理档位需由该 profile 的模型目录及提供方支持。未配置角色模型时仍使用原生会话选择；Worker 可继承 Bot 的选择。Full Access 是用户对本机执行的明确授权，项目目录不再作为安全沙箱。Super Bot 继续记录任务归属、输入、结果和执行收敛，不把模型报告当作人工验收。

正式分发 tgz 时使用新版本和新文件名；复用同版本文件可能命中包管理器缓存。本地开发用上面的 `dev:reload` 或 `dev`，无需升版本。仅在 Bot、Worker 都空闲时更新/重新加载日常插件，并核实激活结果；插件清单显示新版本不能单独证明旧运行实例已替换。插件配置/业务模块可热替换，涉及 DSH 框架、共享宿主依赖的更改仍可能要求重启，以原生 HMR 诊断为准。

## 当前可试用流程

第一次使用真实账号时，可按 [真实模型试用步骤](docs/first-trial.md) 走一项本地文件任务。

1. 在 Super Bot 中填写名字，点击“创建并聊天”；职责可以留空。已有 Bot 点“继续聊天”即回到原对话。
2. 在原生模型选择器中选择并配置模型。直接交代工作，例如：“写一份新同事入职准备清单，保存成 Markdown，包含入职前、第一天和第一周三部分。”
3. Bot 自行安排文件任务；有问题在原对话回答。完成后在同一对话查看摘要、检查说明和成果下载链接。
4. 需要修改就继续说；Bot 将实际用户消息交给对应任务返工。完成后点交付中的“查看成果并确认”，直接进入该成果详情，检查后点击“接受成果”。Bot 不能代替人点击接受。
5. “工作与设置”用于按需查看进度、设置参考材料、停止或处理异常；正常接单不需要任务表单、Session ID 或手动开始。

聊天接单与反馈会记录真实原生用户消息来源；自动通知不能充当用户请求。文件链接只读取已报告的任务成果，下载时重新验证哈希；文件改变后需要重新提交。默认人工最终确认。Full Access 下可用能力跟随宿主及其插件，具体外部服务仍需对应配置与任务授权。

确定性测试只证明流程与约束，不能代替真实模型质量验收。测试模型只存在于单独的契约测试插件中，不随产品包交付。

DSH 的原生变更视图会包含同一轮期间工作树中的其他编辑，不能单独证明哪些内容由 Worker 修改。Super Bot 验收使用任务成果清单与文件哈希；隔离测试夹具为每个合成目录建立独立 Git 边界，避免开发仓库改动混入测试视图。


## 聊天旁工作视图

DF-06 工作入口复用原生 Bot 对话和右侧栏：有聊天记录时在对话顶部显示“工作”，空白 Bot 对话在欢迎区显示同一入口。再次点击可收起；右侧“返回聊天”只关闭工作视图，不另建或切换对话。宽屏使用原生侧栏，窄屏采用原生全屏规则；加载后的宽窄屏已由外层浏览器核对，见[第三轮记录](docs/dogfooding-2026-11-08.md)。

- 默认按“哪里需要我 / 正在做什么 / 交付了什么”分组，组内数量明确为当前页；保留总数、搜索、状态筛选和分页。长目标只显示摘要，详情可展开全文。
- 侧栏选中任务后直接看详情，“全部工作”回到列表。问题回答、停止、恢复、返工和人工接受仍调用原账本操作；报告不等于完成，未收敛、返工中或已取消的报告不会标成可验收成果。
- 完整报告、验证记录、执行会话、审计、Bot 设置与账本维护默认折叠。成果文件链接继续走原有认证与哈希校验；下载不代表接受。
- 入口按原生 Session 查询当前有效 Bot，不使用浏览器最后选择的 Bot。普通会话、Worker 和旧 Bot 对话不会借用别的 Bot 的任务；导航或会话变化会使旧查询失效。

定向回归命令（合成原生边界 + 实际产品账本/客户端逻辑，不代替浏览器验收）：

```sh
fnm exec --using=24.21.0 node --import tsx --test test/adapter/work-view.test.ts
```

Worker 完成源码验证后，外层已在 Bot/Worker 空闲时执行原生 HMR，并核对入口、宽窄屏和真实返工；所有成果继续待人工验收。

## 原生侧栏命名与整理（DF-08）

新 Worker 在关联确认前主动写入短任务名（如 `Worker · DF-08 dogfooding · a1b2c3`），同任务返工继续使用原会话和名称。新项目 Workspace 使用真实项目目录的末段名称，不用首项长目标；复用的既有 Workspace 一律不改名，包括看似旧自动名的分组，以保留共享项目和用户命名。已有分组请使用原生侧栏菜单手动改名。

Bot 的“工作”视图提供两个显式动作：

- **置顶主聊天**：仅点击时调用原生置顶。打开 Bot、准备 Worker、整理名称都不会置顶，因此不会重置用户取消置顶的偏好；需要取消时使用原生菜单。
- **整理自动会话名**：仅整理当前 Bot 已加载、账本能证明为插件创建的普通会话。只有原生标题缺失、fallback/provider 自动来源才改名；任何 user 来源均保留，哪怕用户恰好取名 `Untitled` 或与旧自动名相同。外部授权关联会话、其他 Bot、旧 Manager、过期目标代数、子 Agent、fork、目录不符及已归档会话不处理。未加载历史不会为整理而唤醒，可在原生明确打开后再次整理，或直接手动改名。

整理可重复运行；命名或持久化失败只重试展示整理，不会重新执行任务。已追加的标题在重试时不重复追加，持久化核对仍会重试，期间的用户改名保留。原生明确返回不同创建 ID 时会保留硬性待核对标记，后续不会自动收养原请求 ID；当前没有自动解除该标记或自动重建入口，不能把错误提示当作已经提供可安全恢复的 UI。

**不自动归档、取消归档或改变执行/人工验收状态。** 历史归档保留原生手动入口，不为了隐藏活动、待验收或待返工 Worker 而归档。

定向回归（合成账本/宿主边界及实际安装库的标题语义，不代替浏览器验收）：

```sh
fnm exec --using=24.21.0 node --import tsx --test test/adapter/sidebar.test.ts test/adapter/manager-lifecycle.test.ts
```

Worker 完成源码验证后，外层已在空闲时加载，核对真实侧栏、已有历史整理、置顶/取消置顶及同任务返工；另通过原生菜单整理了历史 Workspace。过程和异常见[侧栏整理记录](docs/dogfooding-sidebar-2026-11-09.md)，所有成果仍待人工验收。

## Bot 设置与参考资料

“编辑 Bot 设置”可修改名称、职责和参考文件。每个文件最多 16 KiB，保存时记录文本内容与哈希；不会扫描目录，也不会在执行时自动读取文件的新内容。保存后的参考文本会交给所选模型，备份也包含这些快照。

任务保留创建时的 Bot 配置版本；修改 Bot 只影响以后创建的任务。旧任务仍使用原职责与原参考内容，防止执行中悄悄改变约定。配置确有变化时，旧管理对话保留为历史并失去管理权限，回首页点 Bot 会准备新的对话，需要重新选择模型。管理对话正在工作时不能修改配置；未改变内容的保存不会更换对话。

## 持久 Manager

创建或打开 Bot 时自动准备当前对话；在原生界面选择模型。它可以通过聊天创建任务，也会接收新任务、回答、返工和执行结束的重要事件。仅完整且处于自动管理状态的任务可派发；默认由人最终验收。创建任务时明确授权的低风险任务可由 Bot 验收，记录不会伪装成人工接受。

Full Access 下 Bot 同样保留原生工具，负责协调、检查和交付，并通过账本委派 Worker 实施。旧 files 模式的 Manager 仅开放管理工具。文件预览每项最多 12,000 字节，验收仍校验完整文件哈希；超过预览范围的成果转人工检查全文，即使任务允许 Bot 验收。任务按 Bot 隔离；自动返工最多 2 次，要求第三次时暂停并转人判断。自动管理每 Bot 同时一轮、全局最多两轮；files 模式每轮最多 12 步、Full Access 模式最多 24 步；自动唤醒的轮次另限 5 分钟，每 Bot 最近一小时最多 20 次自动唤醒。进度报告不唤醒 Manager。

Bot 之间轮流获得自动管理机会；同一 Bot 的用户回答、人工返工和恢复通知优先。一个管理会话暂不可用不会挡住其他 Bot，错误会显示在工作台。通知回执不明时取消该轮并保留核对状态，不自动重发未知通知。

“管理会话设置”可在空闲时更换对话。原对话与任务保留，新对话从账本恢复；旧对话不能继续修改任务。更换中途被中断后，重试只核对该次更换对应的会话；若新对话尚未选模型，需要手动选择，不会借重试覆盖后续的模型选择。返回工作台会保留当前 Bot 选择。

## 备份、恢复与卸载

工作台底部“备份账本”使用 SQLite 一致性快照，并返回备份路径和清单。它可以在宿主运行时执行；同一请求重复到达保留首次已发布的快照，即使清单写入时中断也不会替换它。原快照被删除或损坏时会报错，需要重新点击备份创建新快照。文件位于数据目录的 `backups/`，权限为仅当前用户可读写。

**账本备份不包含成果文件、DSH 会话或模型凭证。** 清单列出需要另行保留的会话 ID 和工作目录。不要只复制一个正在使用的 `ledger.sqlite` 而遗漏 WAL；应使用面板的备份操作。

先停止使用该账本的宿主，再恢复到一个尚不存在的新目录：

```sh
npm run restore:ledger -- /absolute/path/backup.sqlite /absolute/path/new-super-bot-data
```

如果只有 tgz，先解包，然后用 `node /absolute/path/package/scripts/restore-ledger.mjs /absolute/path/backup.sqlite /absolute/path/new-super-bot-data` 调用包内脚本。

恢复脚本检查完整性和 schema，拒绝覆盖现有目录。恢复后的未完成任务全部暂停并产生待核对事项，旧管理通知不自动重放；备份之后真实文件或会话可能已经变化，需要逐项核对。原账本与备份不会被修改。当前 schema 为 7，恢复脚本接受 schema 6～7 的备份；schema 6 在新宿主首次打开时事务升级。其他版本会拒绝，需先使用对应版本处理。升级前应先备份；旧插件不能打开已升级账本。回退时停止宿主，使用旧版插件、对应旧版恢复脚本和升级前的备份恢复到新目录，不能覆盖或降级当前数据库。

启动宿主时设置 `SUPER_BOT_DATA_DIR=/absolute/path/new-super-bot-data`，或在插件配置中设置 `dataDir`（配置优先）。继续使用原 DSH home，或先恢复对应会话与成果目录；仅修改数据目录不会搬迁那些文件。切回原账本时，停止宿主并撤销该设置。不要同时运行两个宿主操作同一组会话/成果。

在隔离 profile 中卸载、重装的命令为：

```sh
DSH_HOME=/absolute/path/dsh-home dsh plugin --profile profile-name remove @zxdvd/super-bot
DSH_HOME=/absolute/path/dsh-home dsh plugin --profile profile-name add /absolute/path/super-bot
```

执行前停止该宿主，之后重新启动。卸载会移除产品入口/API/工具，不删除账本、原生会话或成果。此流程已在测试 profile 验证；运行中热卸载尚未验证。
