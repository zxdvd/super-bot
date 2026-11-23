# Super Bot

与长期存在的 Bot 聊天，把事情交给它，由它安排执行、跟进并回来交付。工作面板用于按需查看进度、成果与需要你处理的事项。

**聊天表达意图；面板展示事实；程序维护状态；模型负责判断。**

当前为本地开发预览，通过 DSH Web 安装。与 Bot 聊天即可安排普通 Full Access Worker 执行，原对话接收交付并继续补充或返工。另一台机器试用只需一个 Web profile。macOS 同机只读镜像是可选功能。

- **自动验证。** Node `24.22.1` 的完整检查通过，含 98 项核心与 SDK 测试、310 项宿主适配测试、行数检查、类型检查及 Host/Client 构建。隔离 DSH 原生 Host 使用确定性模型验证聊天交付、版本附件与 Markdown 记忆等契约。
- **真实使用记录。** 日常 Web 已实际从原聊天派发普通 Worker、交错回答两个任务的问题、收取并打开精确成果、返工和核对恢复。隔离浏览器曾由开发者点击接受新版，账本记录了该测试的人工接受。各项范围见 [实施路线](ROADMAP.md)。
- **待用户验证。** 全新克隆后用自己的模型完成个人首版试用及最终接受，核对真实模型处理歧义与成果质量。日常 Web 和 macOS Desktop 的同机配对体验、精确费用归因也待核对。试用步骤见 [第一次真实模型试用](docs/first-trial.md)。

## 产品边界

- Bot 是长期身份；Task 是责任对象；Run 是一次尝试；执行 Session 可以替换。
- 默认人工最终验收；Bot 可以检查证据并提出最多两次自动返工。
- 单用户，每个宿主各持自己的 SQLite；多个 Bot、普通原生任务 Session、需要人工处理的事项优先展示。同机配对可选，只读查阅对端原账本。
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

先确认 `node --version` 至少为 `24.9.0`，构建命令和启动 DSH 的终端都要满足此要求。源码完整检查使用 Node `24.22.1`，隔离 macOS Desktop `0.2.2-rc.5` Host 自带 Node `24.21.0`。插件声明支持 DSH Web `0.2.2-rc.1` 和 `0.2.2-rc.5`，两版都有原生宿主验证，仓库的 SDK 与 CLI 锁定 `rc.1`。已有兼容 DSH 可直接使用。没有 CLI 时可运行 `npm install -g @deepseek-ai/dsh@0.2.2-rc.5`。CLI 的 `plugin add` 需要 PATH 上有 `pnpm`，先用 `pnpm --version` 核对。

从新克隆的源码目录构建并打包。`check` 的最后一步会生成 `lib/`，`npm pack` 读取该目录。已有 tgz 可从下一段开始。

```sh
npm ci
npm run check
npm pack
```

为试用选一个独立的 DSH home 和新 profile。替换下面的绝对路径，tgz 文件名以 `npm pack` 的输出为准。

```sh
export DSH_HOME=/absolute/path/super-bot-trial-home
# 仅首次创建该 profile 时执行
dsh --profile super-bot-trial --from-default-profile web --dump-config > /dev/null
dsh plugin --profile super-bot-trial add /absolute/path/zxdvd-super-bot-0.1.3.tgz
dsh --profile super-bot-trial --host 127.0.0.1 --no-open --port 3081
```

`--from-default-profile web` 会用模板替换目标 profile。更新已有 profile 时，先备份并停止对应宿主，再使用同一个 `DSH_HOME` 和 profile 运行 `plugin add` 和启动命令。每份账本由一个宿主打开。

打开启动终端打印的完整登录链接，在 Web 的「设置 → 模型」配置试用账号，再从左侧进入 Super Bot，创建并打开 Bot 对话，在原生模型选择器里明确选择模型。模型目录、提供方及认证由 DSH 管理。新 home 使用自己的存储及账号配置；提供方仍可能读取启动环境里的认证变量。Super Bot 角色覆盖可引用当前 profile 已有的模型，见 [角色模型与 Worker](#使用完整原生-worker)。未明确选择且无适用覆盖时，未配置模型的派发不会创建 Run，Manager 待发通知继续保留。登录、密钥及额度错误在工作台提示，可回原生设置处理。试用流程见 [第一次真实模型试用](docs/first-trial.md)。

如果在另一台机器运行，把 Web 绑定到 `127.0.0.1:3081`。在浏览器所在机器执行 `ssh -N -L 127.0.0.1:3081:127.0.0.1:3081 user@trial-host`，保持隧道连接，再打开远端终端打印的完整登录链接。本地和远端使用相同端口，生成的交付链接也能沿该隧道打开。单独使用 Web 即可试用，macOS 用户可按需配置 [同机只读镜像](#同机-web-与-desktop-只读镜像)。

## 本地开发预览

开发时可用 `link:` 加载当前源码目录的构建产物。沿用前面的独立 `DSH_HOME` 和 `super-bot-trial` profile，首次创建 profile 时先执行上面的初始化命令。已有宿主链接到同一工作目录时，等 Bot、Worker 和后台活动空闲并停止对应宿主，再构建、首次链接或由 tgz 切换到链接。从源码根目录运行：

```sh
npm ci
npm run build
dsh plugin --profile super-bot-trial add "link:$PWD"
dsh --profile super-bot-trial --host 127.0.0.1 --no-open --port 3081
```

已链接当前仓库并加载支持许可的版本后，保留 Web 原生 HMR 及默认 `root: []`，在沿用同一 `DSH_HOME` 的源码终端运行：

```sh
SUPER_BOT_PROFILE=super-bot-trial npm run dev:reload
SUPER_BOT_PROFILE=super-bot-trial npm run dev:reload -- --wait 30
```

`dev:reload` 依次使用 `SUPER_BOT_PROFILE`、当前 DSH 会话提供的 `DSH_PROFILE`、默认 `web`，`DSH_HOME` 默认 `~/.dsh`。默认忙碌即打印阻塞项并退出，`--wait` 接受 1～120 秒。授予许可后暂时关闭新派发、会话准备和 Manager 自动唤醒，在 `.runtime` 构建，再通过 DSH 原生 HMR 发布。`Applied` 代表同一宿主的新实例回报了本批构建。Ctrl-C 可取消等待或尚未发布的许可，未触发的许可会自动到期。发布后缺匹配回执时，以原生日志和 Plugins 状态为准。旧版缺许可入口时，先按上面的停机步骤构建并启动。机制与复验见 [开发热加载说明](docs/development-hmr.md)。

宿主已加载支持成果回执的版本后，可用 `npm run dev:reload -- --result <成果ID>` 把一次开发重载关联到当前仓库的已收敛成果。任务详情显示成果 ID。宿主核对暂存构建中包含的成果源码和同进程接棒，成功后登记构建号及时间供任务详情查询。普通重载命令也可照常使用。

保护适用于上述 `dev:reload`。普通构建、源码监听、手工改配置和 DSH 自行重组仍可触发各自的热加载。日常宿主运行期间，可用 `SUPER_BOT_BUILD_OUTDIR=.runtime/check npm run check` 验证源码而不发布到共享 `lib`。DSH Client HMR 刷新前端时，页面局部状态可能重置。需要自动监听源码时，使用下面的独立开发宿主：

在没有其他宿主使用该工作目录 `lib/` 的情况下，可运行 `npm ci`、`npm run dev`。`dev` 从仓库锁定的 DSH CLI 启动，使用 `.runtime/dsh-dev` 下的独立 home 和 `super-bot-dev` profile，默认监听 `127.0.0.1:3081`，可用 `SUPER_BOT_PORT` 改端口。自动构建监听 `src`，Host HMR 监听 `lib/index.js`，Client HMR 刷新 `lib/client.js`。进程使用自己的 DSH 存储，也会继承启动环境变量。用终端的登录链接进入，Ctrl-C 退出。再次运行保留任务数据，默认账本位于该 home 的 `super-bot/ledger.sqlite`。

- `npm run check` 包含行数检查、类型检查、核心账本测试、DSH 适配层测试和 Host/Client 构建。`npm test` 单独运行账本测试。
- `npm run smoke:notifications`：自建全新隔离 home/profile/账本与确定性提供方，验证 Manager 未就绪、额度恢复、通知回执崩溃及重复重启；无真实模型费用、无生产连接。
- `npm run smoke:chat`：在专用探针宿主上验证聊天接单、同对话交付、文件下载、提问回答、返工、Bot 直接 Shell 查询/noWait 拒绝与 Worker 原生 Shell 文件任务；仅确定性模型，不依赖外部服务。可传专用宿主日志：`npm run smoke:chat -- .runtime/permissions-host.log`。
- `npm run smoke:feishu`：启动两个独立 DSH profile，以合成飞书传输和确定性模型验证绑定、网页发起任务、飞书追问和作答、原生聊天交付、断线重连及重启。无需真实飞书或模型凭证。
  设置 `SUPER_BOT_TEST_PLAYWRIGHT` 和 `SUPER_BOT_TEST_BROWSER` 为 Playwright 模块、Chromium 可执行文件的绝对路径，还可检查真实 Web 设置面板和原生聊天。
- `node scripts/smoke-delivery-receipt.mjs <隔离宿主日志>`：使用确定性探针和每小时一次的唤醒限额，验证工具回包、原聊天链接回执、版本下载及人工验收状态。运行条件与证据见 [DF-14](specs/changes/2026-11-super-bot-mvp/evidence.md#2026-11-21-df-14--原聊天成果回执)。
- `npm run smoke`：测试宿主运行时检查真实状态、WAL、未认证访问与跨域拒绝。
- `npm pack --dry-run`：核对分发清单；运行数据和契约测试插件不进入安装包。

Node 用 fnm 管理时，可用 `fnm exec --using=24.21.0 npm run dev`，无需改变机器默认版本。完整执行流程和可靠性门槛见任务清单。未启用 Manager 时，创建任务只保存目标，“开始执行”才调用原生会话中选定的模型。启用 Manager 后，完整且未暂停的任务会自动安排执行；Bot 的 `create` 默认在同一次调用内准备 Worker 会话并派发（执行名额满时排队），缺省的范围/验收由 Bot 推断或使用保守默认值；`dispatch: false` 保留先澄清缺项的流程。需要先核对时，请在创建表单选择“先暂停”。Worker 使用普通 DSH Session。默认（省略 `fullAccess` 或设为 `true`）使用原生 Full Access 预设和宿主可用工具，包括 Shell、Git 与子 Agent；Super Bot 不再附加工具白名单、目录守卫或执行步数/时长上限。每个任务的工作目录由 Bot 按实际情况选择（见下文“任务工作目录”），配置只给出允许范围、默认策略和可选 hook。全局默认最多两个未收敛任务。独立任务可在同一或嵌套目录并行，执行名额满时按先后顺序排队。暂停阻止后续派发，停止请求取消并核对收敛。只有显式 `fullAccess: false` 才启用 files 模式，用于兼容和隔离验证：只允许任务目录内 read/write/edit 与报告，每次最多 40 步或 10 分钟，目录变化和预算耗尽转核对。


可选限额（Super Bot `config` 下，均为正整数）：`maxRunningTasks`（全局同时执行的 Worker 任务，默认 2）、`managerWakesPerHour`（每个 Bot 每小时自动唤醒，默认 20；达到后在状态里记录一次问题并保留通知，下一次成功唤醒后清除）、`managerConcurrentWakes`（同时唤醒的 Bot，默认 2）、`managerTurnMinutes`（单次自动 Bot 轮次上限，默认 5 分钟）。补交付最多 3 次、files 模式 40 步/10 分钟仍为固定值。

## 从 Bot 对话管理已有任务

在原 Bot 对话中明确指出任务和动作，例如「暂停文档任务的自动管理」「恢复文档任务的自动管理」「停止文档任务当前这次执行」或「取消文档任务」。消息里的工作链接会限定本次操作对应的任务。暂停期间，已在执行的 Worker 可以继续。停止只请求结束当前这次执行并暂停自动管理，Bot 按回执报告正在停止、已停止或待核对。取消要求执行已收敛，保留历史和成果记录。需要先停止或核对时，Bot 会报告当前限制，由你决定下一步。

## 在飞书群继续与 Bot 聊天

每个本端 Bot 可绑定一个群。群成员都能看到发到群里的内容，只有配置的飞书账号发出的文本会进入 Bot 的原生管理对话。绑定后，网页真人消息和 Bot 的最终可见文本回复会发到群中。关闭网页后，只要 DSH 宿主还在运行且长连接可用，就可以继续在群里发消息。

### 准备飞书应用和宿主

1. 在飞书开放平台创建企业自建应用，启用机器人能力，确保应用可用范围包含你要授权的账号。申请 `im:chat:create`、`im:chat:read`、`im:chat.members:read`、`im:message:send_as_bot`。要免 `@` 发送，再申请 `im:message.group_msg`（接收群聊中所有消息事件，敏感权限）；若仅获准使用 `im:message.group_at_msg:readonly`，请在每条群消息里 `@` 机器人并附上正文。[飞书消息权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)
2. 获取应用的 App ID、App Secret 和授权账号在**这个应用下**的 `open_id`。可在同一应用的飞书 API 调试台通过手机号或邮箱查询，选择 `open_id` 类型。该查找操作需要 `contact:user.id:readonly`，Super Bot 运行时直接使用你提供的 ID。[通过手机号或邮箱获取用户 ID](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch_get_id)
3. 在专门运行飞书接入的 profile 中配置 Super Bot。选该宿主自己的原账本目录。同一个飞书应用只在一个 Super Bot 宿主启用。其他 profile 默认关闭。

   在该 profile 的 `cordis.patch.yml` 为现有 `super-bot` 配置追加 `feishu.enabled`，保留已有字段：

   ```yaml
   - id: super-bot
     config:
       feishu:
         enabled: true
   ```

   用本地编辑器在同一 profile 目录保存 `super-bot.feishu.json`。Web CLI 的目录是 `$DSH_HOME/profiles/<profile>`，其中 `DSH_HOME` 默认 `~/.dsh`。该文件由启动 DSH 的用户持有，设为 `0600`，例如在目录内执行 `chmod 600 super-bot.feishu.json`。将占位符换成你的凭证值。

   ```json
   {
     "appId": "cli_REPLACEAPPID",
     "appSecret": "REPLACE_WITH_APP_SECRET",
     "ownerOpenId": "ou_REPLACEOPENID"
   }
   ```

4. 启动该 DSH 宿主。在飞书开发者后台「事件与回调 → 事件配置」选择**使用长连接接收事件**，添加「接收消息」`im.message.receive_v1`，发布包含权限和事件配置的应用版本，并完成租户要求的审批。如果控制台要求已连上的实例再保存，请先保持宿主运行。宿主向飞书发起 HTTPS 和 WebSocket 连接，无需对飞书开放回调端口。[飞书长连接事件配置](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)

### 绑定与试用

1. 从 Super Bot 首页打开本端 Bot 的「继续聊天」，在原生管理对话选择可用的模型。回到首页，从该 Bot 的「工作 → ⋯ → 飞书群」核对连接状态。
2. 选择「新建私有群」并输入群名。新群包含应用机器人与配置的飞书账号。也可先将机器人和授权账号加入已有群，选择「绑定已有群」，输入 `oc_` 开头的群 `chat_id`，预览群名并确认。可用同一应用在飞书 API 调试台「获取用户或机器人所在的群列表」找到 `chat_id`。[飞书群 API](https://open.feishu.cn/document/server-docs/group/chat/intro)
3. 点击「在飞书打开群」。从网页发一句新消息，在群里回复，再回原生 Bot 对话核对。可用一项需要追问的合成任务演练，把答案发到群里，回工作台检查成果并验收。

可以在群里委派任务、回答追问或要求返工。暂停、恢复、停止、取消和最终验收请在 Web 完成。同步只覆盖长连接就绪后、绑定生效后的新文本，断线期间的消息和已有历史不会补发。图片、文件、卡片等内容不传输。可从 Web 下载成果附件，正文内已有的成果链接仍适用原宿主的访问权限。

连接或投递异常会显示在「飞书群」设置。请核对应用版本、权限和机器人群成员资格；原对话保留有效内容。建群结果待核对时，用原名称重试；若飞书已经建群，可以找到 `chat_id` 后预览绑定。「解绑」立即撤销后续同步，飞书内的群和已发送的消息会保留。要停止整个 profile 的接入，移除 `feishu.enabled` 或设为 `false` 后重启宿主。更换凭证后也需要重启，旧绑定会按原应用和授权账号识别。

## 使用完整原生 Worker

角色模型和项目目录可在所用 profile 的 `cordis.patch.yml` 中配置。管理会话已有模型记录时沿用原生选择；仅在没有模型记录时用 `managerModel` 填入默认值。Bot 派发时，Worker 优先使用 `workerModel`，其次使用 Worker 会话已记录的原生选择，再继承当前 Bot 对话已记录的选择。手动开始和核对后继续使用 Worker 角色覆盖或 Worker 原生选择。以下 provider、model 和推理档位均为占位示例，请换成当前 profile 已配置并受提供方支持的值。

```yaml
- id: super-bot
  config:
    fullAccess: true  # 默认开放 Bot 查询工具（含 Shell）及 Worker Full Access；false 用于隔离/兼容测试
    allowedRoots: [/absolute/path/projects]  # 任务目录只能落在这些根之下
    managerModel:
      provider: your-provider
      model: your-model
      reasoningEffort: medium
    workerModel:
      provider: your-provider
      model: your-model
      reasoningEffort: xhigh
```

## 同机 Web 与 Desktop 只读镜像

在两端的 Super Bot 首页可同时看到 Web 和 Desktop 创建的 Bot。同名 Bot 用创建端和完整 ID 区分。本端 Bot 继续使用原生聊天和完整工作台。打开带「只读」标记的 Bot 可查任务、进度、历史成果和验收记录。附件显示已报告的数量，在创建端使用原来的入口校验和下载。来源端离线或配对无法核对时，页面会清除对端查询结果并自动重读，本端照常工作。

在同一 macOS 用户下运行 Web 与 Desktop，并确认两端当前实际使用的 profile 和 `dataDir`。首次配对前，分别在原宿主核对已有 Bot 和账本位置。保留各自的 `dataDir` 和原 SQLite；同一个 `DSH_HOME` 下两个宿主默认可能指向同一 `super-bot` 目录，只有确立各自独立的原账本后才能配对。全新的宿主可先设置独立 `dataDir`，由它自己创建空账本。旧账本缺少创建端标记，首次启用以既有路径和用户核对的原宿主归属为准。已配对账本的私有归属标记会在禁用镜像后保留。

1. 两端空闲后，在各自宿主加载本版 Super Bot。创建两端共用的私有配对目录（权限 `0700`），在其中保存 `pair.json`（权限 `0600`）。用 `openssl rand -hex 32` 生成该配对独享的密钥，只写入私有文件。填入四个已核对的绝对目录，使用 `realpath` 的结果。

   ```json
   {
     "key": "填入上一步生成的64位十六进制密钥",
     "web": { "profileDir": "/absolute/web/profile", "dataDir": "/absolute/web/super-bot" },
     "desktop": { "profileDir": "/absolute/desktop/profile", "dataDir": "/absolute/desktop/super-bot" }
   }
   ```

2. 在两个 profile 的 `super-bot` 配置中各增加同一个 `mirrorDir: /absolute/private/pair-dir`。保留原配置的 `dataDir`、模型、权限和目录等字段。空闲时重启两端，打开 Super Bot，核对同名 Bot 的创建端和 ID，再试本端的「继续聊天」与对端的「查看工作」。撤掉 `mirrorDir` 后重启即可停止共享，仍用原 profile 和账本。

配对走本机回环地址，只提供 Bot 目录、分页任务、任务详情和精确会话归属查询。配对文件及密钥由两端信任的同一操作系统用户管理。账本已确认属本端时，配对文件缺失、权限不符或身份不匹配只会暂停镜像，首页会显示原因。账本归属错误或无法核实会拒绝开库。

在 DSH 原生聊天打开当前由 Super Bot 创建和管理的 Manager 或 Worker，会话头部显示创建端。对端显示「请在创建端继续」，原生会话列表沿用 DSH 规则。日常 Web 和 Desktop 的界面验收由用户完成。

隔离复验可运行 `node scripts/smoke-mirror.mjs`，需要 Node `>=24.9`、`lsof` 和已安装的 macOS DeepSeek Harness。脚本使用两个真实 Host、独立 profile/账本和确定性测试模型，运行证据保存在 `.runtime`。验证换端口后从原聊天打开成果时，设置 `SUPER_BOT_TEST_CHAT_LINKS=1`、`SUPER_BOT_TEST_PLAYWRIGHT`（Playwright 模块绝对路径）和 `SUPER_BOT_TEST_BROWSER`（Chromium 可执行文件绝对路径），再运行同一命令。浏览器连接隔离 Desktop Host 的 HTTP 载体。日常原生 Desktop 窗口留待实机验收。

## 任务工作目录

Bot 在 `super_bot_manage` 的 `create`/`dispatch` 中可传 `workdir`，按任务选择目录（省略时用 `defaultWorkdir`）：

| mode | 含义 | 必填 |
| --- | --- | --- |
| `existing` | 直接在已有目录工作，多个任务可以共用该目录 | `path` |
| `isolated` | 在 `defaultIsolatedDir`（或 `under`）下新建 `<name>-<id8>` 空目录 | 无 |
| `worktree` | 从 Git 仓库顶层的已提交 `base`（默认 `HEAD`）建 worktree，分支 `sb/<name>-<id8>`（或 `branch`） | `repo` |
| `hook` | 运行配置的 `workdirHook.create`，读取 stdout 最后一行 `SB_WORKDIR=<dir>`（缺省为 hook cwd 下的 `<name>`） | 无 |

所有路径解析 realpath 后必须位于 `allowedRoots` 内，且不能是 HOME、`/`、Super Bot 数据目录、`deniedPaths` 或 `.ssh`/`.aws`/`.env`/`*.pem` 等敏感位置；违反时返回 `workdir-rejected`，Bot 应换目录或询问用户。hook 的变量只通过环境变量传入（`SB_NAME`、`SB_TASK_ID`、`SB_WORKDIR`、`SB_ARG_<KEY>`，命令里的 `{name}`/`{args.x}` 会被替换为带引号的变量引用），参数名须在 `argNames` 中，值只允许字母数字和 `._/ -`；失败或超时（默认 300 秒，应小于 `managerTurnMinutes`）不重试，返回 `workdir-hook-failed` 并清理 hook 留下的空目录。同一请求重试不会重复运行 hook。

清理默认手动（`workdirCleanup: manual`），任务结束后可在任务详情的“工作目录”卡片点“清理”。`existing` 目录由用户维护，含未提交改动的 worktree 会保留，hook 清理需配置 `remove`。`on-complete` 会在接受或取消后自动清理。已保存的成果附件仍可下载，旧成果若只有原路径，清理后需先恢复原文件。

旧配置 `workspace: <dir>` 仍可用：等价于 `allowedRoots: [<dir>]`，Git 根目录默认 worktree，并在状态里提示改用新键。`allowedRoots`/`workspace` 指向 HOME 或 `/` 时会被忽略并提示，任务回退到数据目录下的独立目录。

示例（团队多仓工作区工具只是 hook 的一种用法，Super Bot 不内置任何特定工具）：

```yaml
- id: super-bot
  config:
    allowedRoots: [/absolute/path/projects]
    defaultWorkdir: isolated          # isolated | worktree | hook | none
    defaultIsolatedDir: .super-bot-workspaces
    deniedPaths: [/absolute/path/projects/secrets]
    workdirCleanup: manual            # manual | on-complete
    workdirHook:
      description: 用 team-workspace 创建包含多个仓库的工作区
      cwd: /absolute/path/projects/workspaces
      create: tw ws create {name} --repos {args.repos}   # 未输出 SB_WORKDIR 时使用 <cwd>/<name>
      remove: tw ws rm {name}
      argNames: [repos]
      timeoutSeconds: 300
```

推理档位需由该 profile 的模型目录及提供方支持。未配置角色模型时仍使用原生会话选择；Worker 可继承 Bot 的选择。Worker 默认使用原生 Full Access，项目目录不作为安全沙箱。升级时，原先省略此键的配置也会使用 Full Access；需要保留旧 files 行为时显式设置 `fullAccess: false`。Super Bot 继续记录任务归属、输入、结果和执行收敛，不把模型报告当作人工验收。

正式分发 tgz 时使用新版本和新文件名，复用同版本文件可能命中包管理器缓存。本地开发用上面的 `dev:reload` 或 `dev`，无需升版本。原生安装和手工改配置仍应等宿主空闲后操作。涉及 DSH 框架、共享宿主依赖的更改可能要求重启，以原生 HMR 诊断为准。

## 当前可试用流程

第一次使用真实账号时，可按 [真实模型试用步骤](docs/first-trial.md) 走一项本地文件任务。

1. 在 Super Bot 中填写名字，点击“创建并聊天”；职责可以留空。已有 Bot 可从左侧列表直接回到当前原生对话。
2. 在原生模型选择器中选择并配置模型。直接交代工作，例如：“写一份新同事入职准备清单，保存成 Markdown，包含入职前、第一天和第一周三部分。”
3. Bot 自行安排文件任务；有问题在原对话回答。完成后在同一对话查看摘要和检查说明，点击成果文件名预览，按需下载。
4. 需要修改就继续说；Bot 将实际用户消息交给对应任务返工。完成后点交付中的“查看成果并确认”，直接进入该成果详情，检查后点击“接受成果”。Bot 不能代替人点击接受。
5. “工作”用于按需查看进度、验收、停止或处理异常；Bot 设置、参考材料和账本维护在工作视图右上角“⋯”里。正常接单不需要任务表单、Session ID 或手动开始。

Bot 检查成果后调用 `super_bot_manage` 的 `deliver`（taskId、resultId、text）生成交付链接。插件核对原生聊天中持久保存的最终回复、正常轮次结束和精确的成果及文件链接之后，才登记回执并结清补交付通知。聊天接单与反馈记录真实原生用户消息来源。自动通知不能充当用户请求。

原生 Markdown 会把根相对地址显示为文件控件，交付消息因此使用生成时的宿主 HTTP 地址。同一创建端 Desktop 换端口后，可从原 Bot 聊天继续打开原 Task 和 Result，附件由当前宿主校验。被替代的版本保留原摘要、检查和附件入口，当前版本沿用人工验收。Worker 通过 `ready` 明确提交的附件与成果一并入账，每份成果最多 10 个文件，单个最多 10 MiB，合计最多 20 MiB。预览与下载均按成果版本核对附件的大小和 SHA-256。升级前未保存副本的附件继续按原路径、大小和 SHA-256 核对。若原文件已丢失或变化，请把提交时的文件恢复到原路径，或请 Bot 重新提交成果。Full Access 下可用能力跟随宿主及其插件，外部服务仍需对应配置与任务授权。

点击聊天文件名在「工作」右栏打开纯文本预览，点击成果详情中的文件名则在该成果内展开。支持 UTF-8 的 `.md`、`.diff`、`.patch`、`.json`、`.jsonl` 和 `.txt`；其他格式可用「下载」取回原始字节。DSH 的原生文件预览从当前会话的文件系统读取路径，Super Bot 成果附件则按成果 ID 和文件序号从账本读取。

确定性测试只证明流程与约束，不能代替真实模型质量验收。测试模型只存在于单独的契约测试插件中，不随产品包交付。

DSH 的原生变更视图会包含同一轮期间工作树中的其他编辑，不能单独证明哪些内容由 Worker 修改。Super Bot 验收使用任务成果清单与文件哈希；隔离测试夹具为每个合成目录建立独立 Git 边界，避免开发仓库改动混入测试视图。


## 聊天旁工作视图

DF-06 工作入口复用原生 Bot 对话和右侧栏：有聊天记录时在对话顶部显示“工作”，空白 Bot 对话在欢迎区显示同一入口。再次点击可收起；右侧“返回聊天”只关闭工作视图，不另建或切换对话。宽屏使用原生侧栏，窄屏采用原生全屏规则；加载后的宽窄屏已由外层浏览器核对，见[第三轮记录](docs/dogfooding-2026-11-08.md)。

- 「需要你」和顶栏共用计数，按任务计入仍开放的提问、原生审批和恢复核对。「待验收」显示当前待验收任务，「新成果」按原聊天有效交付回执显示三天内尚未打开的成果。查看对应成果或点「标为已读」会在当前浏览器消除新成果标记。
- 目标以 `【测试】` 开头的任务默认折叠，阻塞中的测试任务仍计入「需要你」。用户明确委托测试或活验时，Manager 用这个前缀；在「全部」仍可搜索。收件箱保留当前阻塞和最近交付，其余任务按现有窗口查看，亦可切换「看板」或「全部」。
- 任务详情显示最新已记录的 Worker 进度和时间，并列出程序记录的执行、原聊天交付和验收。只读镜像也可查这些记录。开发成果的关联重载回执可在同一处核对。
- 完整说明、任务范围、验收条件与完整 Worker 报告支持基本 Markdown，包括列表、加粗、代码和 HTTP(S) 参考链接。折叠预览保留纯文本。
- 任务详情是覆盖在列表上的抽屉（Esc 或点空白处关闭），头部只放一个随状态变化的主操作（接受成果 / 停止执行 / 去回答 / 开始执行）和“打开 Worker 会话”；返工要求在“要求返工”里展开。问题回答、停止、恢复、返工和人工接受仍调用原账本操作；报告不等于完成，未收敛、返工中或已取消的报告不会标成可验收成果。
- 父 Worker 在原生子 Agent 仍活跃时提交 `ready`，会在同一个轮次等待并保留任务目录占用。子树收敛后，父 Worker 核对子结果，再提交新的 `ready` 给人工验收。
- 工作详情显示 `ready` 或原生轮次即将结束时的子树等待，包括开始时间、已用时、已知待完成数量和可打开的原生子会话。等待结束后可在同一任务查看各 Run 的起止和结局，证据不足的字段显示「未知」。[DF-12 回归记录](specs/changes/2026-11-super-bot-mvp/evidence.md#2026-11-21-df-12--显示实际的子-agent-等待与收敛)
- 在正在执行的 Worker 会话里插话或排队下一条，不会中断当前自动轮次。自动轮次按自身的 `turn/end`、最终报告和后台作业/子 Agent 状态结算，不等待整个会话空闲；因此排队的人工下一轮不会把已正常结束的 Run 误标为中断。新人工轮次会把尚未完成的任务转人工管理，但不会取消该轮，也不会篡改旧 Run 已结算的事实。
- Bot 设置、管理对话、侧栏整理与账本维护移到右上角“⋯”设置页，不再占首屏。成果文件链接继续走原有认证与哈希校验；下载不代表接受。
- 入口按原生 Session 查询当前有效 Bot，不使用浏览器最后选择的 Bot。普通会话、Worker 和旧 Bot 对话不会借用别的 Bot 的任务；导航或会话变化会使旧查询失效。
- 任务详情用短标签展示 Worker 当前原生选择，标签描述保留完整路由、档位及来源。下次 Bot 派发预计与当前选择不同时单独标出。角色覆盖优先，其次是 Worker 会话选择。Bot 可从自己的原生会话继承已记录的选择，手动开始与恢复继续使用 Worker 自己的选择或角色覆盖。在创建端展开「执行模型」才会读取各 Run 的实际请求、原生证据和派发时预计模型。收起后再次展开可刷新；无法确认的字段显示「未知」。详见 [DF-11 验证记录](specs/changes/2026-11-super-bot-mvp/evidence.md#2026-11-21-df-11--显示实际模型与来源)。

定向回归命令（合成原生边界 + 实际产品账本/客户端逻辑，不代替浏览器验收）：

```sh
fnm exec --using=24.21.0 node --import tsx --test test/adapter/work-view.test.ts
```

Worker 完成源码验证后，外层已在 Bot/Worker 空闲时执行原生 HMR，并核对入口、宽窄屏和真实返工；所有成果继续待人工验收。

## 切换 Bot 与 Workspace 侧栏

左侧默认按创建顺序显示本端已有的 Bot。点击名称打开该 Bot 当前绑定的原生对话。左下角「切换到 Workspace」恢复 DSH 的工作区和会话列表，Worker 会话沿用 DSH 的原生展示规则。同一按钮可切回 Bot 列表。切换时当前聊天与右侧工作视图保持打开，重新加载页面后默认显示 Bot 列表。

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

## Bot 的 Markdown 记忆

在 Bot 原聊天明确要求保存默认工作约定，例如「请把『交付前回读文件』保存为以后的默认工作约定」。之后一句清楚的委派即可采用默认约定。在委派中说「这一次请在交付前检查标题，覆盖默认约定」，该任务会保存并采用当次要求。可以在原聊天按任务询问实际采用的约定。以后更新默认值时，已有任务和同任务续跑继续从原任务快照读取。

记忆保存在创建端的 `<dataDir>/memory/<Bot ID>/`。`dataDir` 依次取插件配置 `dataDir`、`SUPER_BOT_DATA_DIR`、`$DSH_HOME/super-bot`，未指定 DSH home 时为 `~/.dsh/super-bot`。按完整 Bot ID 定位目录，同名 Bot 分别保存，更换管理对话继续使用同一目录。新 Bot 创建 `index.md`，旧 Bot 第一次查索引或保存约定时创建。请在原聊天更新默认约定，程序负责维护 `work-convention.md` 的正文和来源顺序。

手工维护决策时，在该 Bot 目录创建 `decisions/`。用 UTF-8 保存独立普通文件，每个文件最多 16 KiB，索引也遵循此限制。文件名以小写字母或数字开头，主文件名最长 80 字符，只用小写字母、数字和连字符，扩展名为 `.md`。例如保存 `decisions/release-checks.md`，然后在现有 `index.md` 追加一行索引，保留其他条目。

```markdown
- [发布检查范围](decisions/release-checks.md)
```

决策文件第一行使用 `[来源]` 链接，空一行再写非空正文。示例里的 UUID 须换成创建端同一个 Bot 的实际 Task ID 和所属 Result ID。也可省略 `&resultId=…` 引用任务本身。可从原聊天的「查看成果并确认」链接取 `/#super-bot-task=…` 路径和片段，去掉协议、主机和端口。请使用仍保存在账本中的任务或成果，问题链接、附件 URL 和外站链接不符合来源格式。

```markdown
[来源](/#super-bot-task=11111111-1111-4111-8111-111111111111&resultId=22222222-2222-4222-8222-222222222222)

发布前检查安装包清单，并在隔离 Web Host 验证登录和成果下载。
```

回到该 Bot 原聊天询问这项决策，确认它引用同一个任务或成果。Bot 会先读索引，再按需读取相关条目并引用程序核验后的来源。只保存需要长期引用的决策与理由，避免把账号凭证、原始聊天和临时工作日志写进会提供给模型的内容。当前聊天保存入口只处理默认工作约定，决策文件和索引由创建端手工维护，镜像只提供只读任务投影。

SQLite 在每项任务创建时保存当时采用的默认约定或本次覆盖及其来源，同任务续跑读该快照。账本备份包含这些任务快照。当前默认约定、决策正文及索引保留在独立 Markdown 目录，按下文 [备份、恢复与卸载](#备份恢复与卸载) 一并保管。

定向回归使用 `node --import tsx --test test/adapter/bot-memory.test.ts`。隔离原生烟测可复用双端载体，使用 `.runtime` 内的构建和全新数据目录：

```sh
SUPER_BOT_BUILD_OUTDIR=.runtime/memory-build npm run build
SUPER_BOT_TEST_BOT_MEMORY=1 SUPER_BOT_TEST_BUILD_DIR="$PWD/.runtime/memory-build" node scripts/smoke-mirror.mjs
```

## 持久 Manager

创建或打开 Bot 时自动准备当前对话；在原生界面选择模型。它可以通过聊天创建任务，也会接收新任务、回答、返工和执行结束的重要事件。仅完整且处于自动管理状态的任务可派发；默认由人最终验收。创建任务时明确授权的低风险任务可由 Bot 验收，记录不会伪装成人工接受。

默认 Bot 开放 `skill`、`bash`、`read`、`read_image`、`job_output`、`job_list`、`job_kill`，外加已有的 `super_bot_manage` 任务/审查/交付工具；不给 `write`/`edit` 或原生 Worker/subagent 工具。工具列表和执行守卫共同约束可用工具。短只读查询（状态检查、git status、lark-cli 查询、需要 Shell 的 skill）直接在 Bot 中完成，不创建 Task；代码/文件修改、多步骤工作和长任务仍通过 Task 委派 Worker。项目查询使用明确的 workdir/file_path，Bot 自身目录不是 Worker 项目目录。Shell 仍有修改本机的能力：查询与修改的意图分工依靠指令，不把白名单或 noWait 宣称为只读沙箱。

Bot 的 bash **也受 `fullAccess` 控制**：默认/true 开放上述工具；显式 `fullAccess: false` 时只留 `super_bot_manage`，Worker 使用 files 模式。Shell/CLI 请求应直接说明“Bot Shell 与 Worker 完整权限未开启”，提示在当前 profile 的 `cordis.patch.yml` 中将 Super Bot 的 `config.fullAccess` 设为 `true`（或移除显式 `false`），待 Bot/Worker 及后台工作空闲后重载插件。不要要求用户“开启工具通道”；权限已开时应报告实际 CLI/登录错误。

Bot 的 noWait 守卫拒绝常见 `sleep` 命令；bash 必须显式指定 `0 < timeoutMs <= 30000`，或 `run_in_background: true`（如同时给 timeoutMs，仍须不超过 30 秒）。所有 preset 都不依赖默认等待时间。`job_output` 默认读取快照；`wait: true` 必须显式给 `0 < timeout_ms <= 5000`。后台查询保留 job ID 后结束本轮，由原生事件通知；不要轮询或等待 Worker。job 工具用于自己的查询，Worker 控制仍走账本。仅补交付恢复期间仍禁止所有原生工具；撤销 Manager 身份后同样拒绝执行。

文件预览每项最多 12,000 字节，验收仍校验完整文件哈希；超过预览范围的成果转人工检查全文，即使任务允许 Bot 验收。任务按 Bot 隔离；自动返工最多 2 次，要求第三次时暂停并转人判断。自动管理每 Bot 同时一轮、全局最多两轮；files 模式每轮最多 12 步、Full Access 模式最多 24 步；自动唤醒的轮次另限 5 分钟，每 Bot 最近一小时最多 20 次自动唤醒。进度报告不唤醒 Manager。

Bot 之间轮流获得自动管理机会；同一 Bot 的用户回答、人工返工和恢复通知优先。一个管理会话暂不可用不会挡住其他 Bot，错误会显示在工作台。通知在 Manager 未启用/创建中/未选模型时也先持久保存，不因暂未就绪而丢弃；不自动创建或重新启用管理会话。入队前错误最多 5 次指数退避（30/60/120/240 秒后再次尝试），到限 blocked；未选模型或忙碌保持 pending，最多每 30 秒重新检查。小时额度用尽则等待最早额度自然过期，不消耗消息尝试。通知回执不明时取消该轮并保留核对状态，不自动重发未知通知。

重启后按稳定消息 ID、Bot/Manager/通知来源、所属轮次和真实持久最终回复/正常结束只读核对 unknown；每条最多 3 次（30/60 秒退避），每批 10 条，不加载 Agent 或调用模型。没有证据就保留 unknown 并说明人工处理；普通管理通知绝不据此重跑工具。恢复 Agent 时只移除精确归属旧 unknown 通知的待处理自动输入，保留人工输入。调度类通知在任务 paused/manual 时保留不唤醒；原有状态、审批、失败和交付提醒不恢复任务执行权限。自动轮次已结束后，旧唤醒超时不会取消人工续轮。诊断、手工 handled / retry-unsent API 与验证边界见 [通知可靠性](docs/notification-reliability.md)。

成果检查后的“仅补交付”通知每个成果最多自动唤醒 3 次（不含原检查轮次），后两次分别等待 30 秒和 60 秒。只有当前通知输入所在轮次已持久化结束，才允许重试；重复结束事件和重载不会重置计数或退避。到上限转为 `unknown`，只记录一次核对提示并停止唤醒，用户可在 Bot 对话或工作面板查看成果。交付识别按链接路径、成果/任务 ID 和文件序号核对，支持相对地址、查询参数换序及端口变化；仍要求真实最终回复、成功结束及持久化证明，不把检查完成、普通确认语或模型自报当作交付。

设置页（“⋯”）的“管理对话”可在空闲时更换对话。原对话与任务保留，新对话从账本恢复；旧对话不能继续修改任务。更换中途被中断后，重试只核对该次更换对应的会话；若新对话尚未选模型，需要手动选择，不会借重试覆盖后续的模型选择。返回工作台会保留当前 Bot 选择。

## 备份、恢复与卸载

设置页（“⋯”）的“备份账本”使用 SQLite 一致性快照，并返回备份路径和清单。它可以在宿主运行时执行；同一请求重复到达保留首次已发布的快照，即使清单写入时中断也不会替换它。原快照被删除或损坏时会报错，需要重新点击备份创建新快照。文件位于数据目录的 `backups/`，权限为仅当前用户可读写。

请用面板的备份操作取得包含 WAL 中已提交数据的一致性快照。SQLite 备份包含任务约定快照和已保存的成果附件。请另行备份创建端数据目录下的 `memory/`，保留完整 Bot ID 目录结构、默认约定、索引和决策文件。按清单另行保留 DSH 会话和未保存副本的原成果文件，模型凭证单独保管。

先停止使用该账本的宿主，再恢复到一个尚不存在的新目录：

```sh
npm run restore:ledger -- /absolute/path/backup.sqlite /absolute/path/new-super-bot-data
```

如果只有 tgz，先解包，然后用 `node /absolute/path/package/scripts/restore-ledger.mjs /absolute/path/backup.sqlite /absolute/path/new-super-bot-data` 调用包内脚本。

恢复脚本检查完整性和 schema，拒绝覆盖现有目录。恢复后的未完成任务全部暂停并产生待核对事项，旧管理通知不自动重放；备份之后真实文件或会话可能已经变化，需要逐项核对。原账本与备份不会被修改。当前 schema 为 11，恢复脚本接受 schema 6～11 的备份。旧账本在新宿主首次打开时事务升级。schema 11 移除执行记录的目录唯一约束，保留已占用的 Worker 名额。schema 10 增加按成果版本保存的附件副本，历史成果继续以原记录为准。schema 9 新增 Run 的原进程轮次/事件坐标与后台收敛证据；旧 Run 不补造证据，未完成且证据不足时仍保留资源待核对。其他版本会拒绝，需先使用对应版本处理。升级前应先备份；旧插件不能打开已升级账本。回退时停止宿主，使用旧版插件、对应旧版恢复脚本和升级前的备份恢复到新目录，不能覆盖或降级当前数据库。

脚本完成后、启动前，将对应备份的 `memory/` 放入新数据目录，保留各 Bot ID 和原有私有权限。SQLite 恢复会带回历史任务约定快照及已保存的附件，但不会从快照重建 Markdown 默认约定和决策笔记。启动时设置 `SUPER_BOT_DATA_DIR=/absolute/path/new-super-bot-data`，或设置优先级更高的插件 `dataDir`。继续使用原 DSH home，或先恢复对应会话与旧成果所需的原文件。切回原账本时，停止宿主并撤销该设置。每组会话和成果由一个宿主运行。

沿用安装时的 `DSH_HOME` 和 profile，可在停机后卸载并按需重装同一 tgz。

```sh
dsh plugin --profile super-bot-trial remove @zxdvd/super-bot
dsh plugin --profile super-bot-trial add /absolute/path/zxdvd-super-bot-0.1.3.tgz
```

执行前停止该宿主，之后重新启动。卸载会移除产品入口/API/工具，不删除账本、原生会话或成果。此流程已在测试 profile 验证；运行中热卸载尚未验证。

### 隔离执行可靠性回归

运行 `npm run smoke:reliability`：每次新建 `.runtime/reliability-*` 下的 DSH home/profile、操作系统 HOME、账本和工作目录，使用无网络确定性 provider。通过真实宿主的 prompt/updateQueue、持久事件与原生文件/报告工具验证插话、续轮、正常/异常结束、未收敛后台作业和进程强制重启；只停止该脚本自己启动的宿主，不连接日常 profile。

默认使用 files 模式，以证明旧工具约束确实在人工续轮前解除；`SUPER_BOT_TEST_FULL_ACCESS=true npm run smoke:reliability` 验证默认 Full Access 路径。脚本不继承模型凭证或生产 dataDir，日志中的本机启动 token 不要分享。结果只证明宿主/账本契约，不替代真实模型质量、浏览器 ↑ 按钮和 Desktop 验收。详见 [可靠性验证](docs/reliability-verification.md)。

重启只读核对持久会话日志：仅在自动输入身份、所属 turn/start/end、边界最终报告及原进程后台安静证据全部匹配时幂等补结算；补结算后暂停任务，不唤醒 Manager、不自动验收或重投模型/工具。只有 ready、缺少权威 turn/end、后台效果未知或旧版本无证据时保留占用并解释 recovery。恢复 Agent 时仅移除可精确归属旧 Run 的待处理自动输入，保留人工输入；不为恢复主动打开会话。
