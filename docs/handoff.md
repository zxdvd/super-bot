# 新会话接手说明

更新：2026-11-09。开发成果保存在 [GitHub dev](https://github.com/zxdvd/super-bot/tree/dev)，当前预览版本 `0.1.3`。本轮收尾是代码和文档交接，不是宣称首版已由用户验收。

## 先读这些

1. [README](../README.md)、[协作规则](../AGENTS.md)：产品入口和操作边界。
2. 本页及[路线](../ROADMAP.md)：当前结论、下一步。
3. [任务清单](../specs/changes/2026-11-super-bot-mvp/tasks.md)：任务勾选的准确范围。
4. [第三轮验证](dogfooding-2026-11-08.md)、[侧栏整理验证](dogfooding-sidebar-2026-11-09.md)：实际成功、异常和外层介入；更早的适配证据见活动 change 的 evidence。

## 已完成

- 聊天为主入口：普通问答、补全请求、Bot 委派 Worker、原对话交付、同任务返工和文件下载均已实际跑过。
- 默认使用普通原生 Full Access Worker（省略 `fullAccess` 或 `true`）；仅显式 `fullAccess: false` 使用受限 files 模式。Full Access 下可以使用宿主工具、Shell、Git 和子 Agent，不额外添加 Worker 工具白名单或步数/时长上限。Bot 用 GPT 6.1 Sol medium，Worker 用同模型 xhigh；路由与凭证留在宿主配置。
- 四轮产品内 dogfooding：通知和交付恢复、多消息、任务补全/去重、respond 空字段修复、原生搜索插件、聊天旁工作面板、侧栏命名与整理。
- 工作面板复用原生右栏，支持宽窄屏；入口按当前有效 Bot 会话核对。主聊天可显式置顶，Worker 自动短名，旧自动会话名可保守整理。
- 最终代码检查为 **195 项通过（68 核心 + 127 适配）**，typecheck/build 通过；Bot 查询工具、默认权限及补交付循环修复见[证据](../specs/changes/2026-11-super-bot-mvp/evidence.md)。同任务、同 Worker 在整理会话名后再次返工并交付已验证。
- Node 默认和日常宿主已使用 `24.21.0`。日常 profile 安装了指定的 dsh-plugins，实际原生 web_search 成功；不能将该本机配置当作插件包自带账号或搜索服务。
- 独立 DSH Web rc.1 的 `smoke:chat` 已通过，包含 Bot 直接 Bash 查询零 Task、noWait 拒绝，以及原生 Bash → 文件回读 → Worker 报告 → Bot 原对话交付；模型为确定性夹具，无外部服务调用。
- 用户批准覆盖 e8e967b 的管理工具独占设计：Bot 默认有 skill/bash/read/read_image/job_output/job_list/job_kill 加管理工具，短查询直接执行；修改、多步骤、长任务仍委派 Worker。不提供 write/edit 或原生 Worker/subagent 工具。Bot Bash 同样受 fullAccess 控制，false 时说明“Bot Shell 与 Worker 完整权限未开启”和 `config.fullAccess: true` 开启方法。
- noWait 强制 Bash 显式最多 30 秒或后台返回，拒绝常见 sleep；job_output 等待需显式最多 5 秒；后台事件自行通知。Shell 不是只读沙箱，语义分工由指令引导。仅补交付恢复/撤权的执行限制保留，细节见 [运行能力](runtime-support.md)。
- 仅补交付通知已加持久化 3 次上限及 30/60 秒退避；旧版本 attempts=14 的 pending 通知会先核对历史，已交付则结束，未交付则停止自动唤醒并保留 unknown。重复 turn/end、重载和旧端口链接均有回归。
- Review 第一批（2026-11-09）：`workspace` 为项目根，任务落在 `.super-bot-workspaces/<taskId>`（Git 项目用 worktree），目录/名额冲突排队；成果拒绝敏感文件。Bot 用 `deliver` 显式交付，插件渲染相对链接，文本匹配仅兜底。`create` 默认一步派发（`dispatch:false` 保留澄清）。唤醒上限记录可见问题；`maxRunningTasks`/`managerWakesPerHour`/`managerConcurrentWakes`/`managerTurnMinutes` 可配置。独立宿主 `smoke:chat` 12 项通过。

## 从现有环境继续

权威源码在 workspace 的 `repos/super-bot`。先检查 `git status`、当前分支和远端，再修改；不要清理运行数据或另建一个替代项目。

日常 DSH Web 使用现有 `~/.dsh/profiles/web`，本轮运行端口为 3080，Super Bot 以仓库本地 link 加载。运行进程会变化，下次应重新核对，而不是沿用旧 PID。日常模型和会话保留在此 profile；不要重复用 `--from-default-profile` 覆盖已有配置。

```sh
node --version                  # DSH 要求 >=24.9，当前验证 24.21.0
fnm use 24.21.0                 # 旧终端仍用其他版本时
npm ci
npm run check
```

本轮升级会使默认/true 的 Bot 重新获得上述七项查询工具；省略 `fullAccess` 的 Worker 继续使用原生 Full Access；若要保留隔离测试行为，先显式配置 `fullAccess: false`。本轮未替日常 Web/Desktop 安装或重载插件，Desktop 真实体验仍未复验。只读检查本机 Desktop 安装包现为 0.2.2-rc.1，其本地宿主使用动态端口；此前文档中的 rc.5 是较早环境记录。

依赖变化才需重装依赖。`npm run check` 会构建产物；正在使用本地 link 的客户端可能刷新。后端热替换只在 Bot、Worker 和后台工作均空闲时进行：

```sh
npm run dev:reload             # 日常 web profile，构建并请求原生 HMR
```

检查插件激活和实际界面；如前端未刷新，可刷新页面。不要只凭命令退出成功判断已加载。改默认 Node 不会替换旧宿主进程，若宿主仍是旧 Node，须空闲后正常重启。

独立开发使用 `npm run dev`：默认端口 3081，数据在 `.runtime/dsh-dev`，不继承日常账号。它适合自动监听；日常自修改 Worker 执行期间不要运行自动后端重载。详见[热加载说明](development-hmr.md)。

## 下一步优先级

1. 请用户走实际聊天和最终接受；CF-02/03 的正式体验核对、CF-04 的人工确认、SB-15/FV 尚未全部完成。现有实现不需要重新从零开发，不能因交接而勾选最终验收或归档 change。
2. 改善 Bot 自动审查的收尾：现有自动管理轮次有 5 分钟上限，本轮一次代码审查超时，外层提供简短上下文后补交付成功。先复现并判断如何减少重复阅读/保留检查进度，不先取消所有约束或扩建调度系统。
3. 跟踪一次生成重复文本的异常：当时写工具尚未执行，停止并换新 Worker 上下文后恢复；根因未确定，没有 DSH/模型引擎修复结论。
4. 继续打磨命名与列表：当前短名为确定性截短，复杂目标仍可能不够语义化；Workspace 无标题来源，已有分组不自动改名；冷历史不会为整理而被唤醒。没有自动归档，待验收/可返工会话始终保留。

Desktop、其他 DSH 版本、精确费用归因、独立 App/Web、云端部署仍后置。已验证版本是 DSH Web `0.2.2-rc.1`，不要将其他版本或更大的任务范围视为自动兼容。

## 继续 dogfooding 的方式

需求、补充和返工从 Bot 主聊天进入，由它使用账本委派 Worker。外层审查文件、检查测试和实际界面，再在空闲时加载。

正在执行的 Worker 会话可以插话或排队下一条来引导当前自动轮次，这不会记为接管，也不应中断该轮。若自动轮次已经结束再开启新的人工轮次，且该执行尚未收敛，才会记为人工接管；此时不要 cancel 用户自己的这一轮，恢复自动管理前仍须在工作台核对。不要编辑 SQLite 或伪造报告来跳过恢复。

## 数据、证据与发布

源码、测试、脱敏文档可提交。`.runtime`、数据库、会话日志、宿主配置和凭证不提交；不要复制整个 `~/.dsh`。任何密钥都只在宿主或环境变量配置。

七项真实任务目前均未人工接受。文件证据按哈希绑定，后续源码/文档变化可能使历史成果下载或接受失效，这是预期保护；需要重新报告，不能将旧结果改成有效。账本备份不包含成果文件或 DSH 会话，恢复方式见 README。

结束当前 Codex 会话不等于停止独立 DSH 宿主。新会话可以直接从本页继续，无需迁移聊天数据库，也无需读取整段旧对话。
