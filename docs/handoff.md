# 新会话接手说明

当前预览版本 `0.1.3`。请按 [README](../README.md) 安装和启动，按 [实施路线](../ROADMAP.md) 核对当前验证和验收状态。本页的 dogfooding 记录始于 2026-11-09，保留早期发现和排查背景。

## 先读这些

1. [README](../README.md)、[协作规则](../AGENTS.md)：产品入口和操作边界。
2. 本页及[路线](../ROADMAP.md)：当前结论、下一步。
3. [任务清单](../specs/changes/2026-11-super-bot-mvp/tasks.md)：任务勾选的准确范围。
4. [第三轮验证](dogfooding-2026-11-08.md)、[侧栏整理验证](dogfooding-sidebar-2026-11-09.md)：实际成功、异常和外层介入；更早的适配证据见活动 change 的 evidence。

## 已完成

- 聊天为主入口：普通问答、补全请求、Bot 委派 Worker、原对话交付、同任务返工和文件下载均已实际跑过。
- 默认使用普通原生 Full Access Worker，显式 `fullAccess: false` 使用受限 files 模式。真实 dogfooding 已使用宿主工具、Shell、Git 和子 Agent。试用模型以当前 DSH profile 配置与原生选择为准。
- 四轮产品内 dogfooding：通知和交付恢复、多消息、任务补全/去重、respond 空字段修复、原生搜索插件、聊天旁工作面板、侧栏命名与整理。
- 工作面板复用原生右栏，支持宽窄屏；入口按当前有效 Bot 会话核对。主聊天可显式置顶，Worker 自动短名，旧自动会话名可保守整理。
- Bot 查询工具、默认权限、补交付循环修复，以及同一 Worker 整理会话名后再次返工并交付的过程见 [验收证据](../specs/changes/2026-11-super-bot-mvp/evidence.md)。历史日常 profile 的搜索能力由另行配置的 `dsh-plugins` 提供。
- 独立 DSH Web rc.1 的 `smoke:chat` 已通过，包含 Bot 直接 Bash 查询零 Task、noWait 拒绝，以及原生 Bash → 文件回读 → Worker 报告 → Bot 原对话交付；模型为确定性夹具，无外部服务调用。
- 用户批准覆盖 e8e967b 的管理工具独占设计：Bot 默认有 skill/bash/read/read_image/job_output/job_list/job_kill 加管理工具，短查询直接执行；修改、多步骤、长任务仍委派 Worker。不提供 write/edit 或原生 Worker/subagent 工具。Bot Bash 同样受 fullAccess 控制，false 时说明“Bot Shell 与 Worker 完整权限未开启”和 `config.fullAccess: true` 开启方法。
- noWait 强制 Bash 显式最多 30 秒或后台返回，拒绝常见 sleep；job_output 等待需显式最多 5 秒；后台事件自行通知。Shell 不是只读沙箱，语义分工由指令引导。仅补交付恢复/撤权的执行限制保留，细节见 [运行能力](runtime-support.md)。
- 仅补交付通知已加持久化 3 次上限及 30/60 秒退避；旧版本 attempts=14 的 pending 通知会先核对历史，已交付则结束，未交付则停止自动唤醒并保留 unknown。重复 turn/end、重载和旧端口链接均有回归。
- `create` 默认一步派发，`dispatch: false` 保留澄清流程。目录或名额冲突时排队。兼容的 `workspace` 配置、当前目录策略和限额见 [README](../README.md#任务工作目录)。交付由 `deliver` 生成链接，宿主在原生持久回复中核对链接再确认回执。

## 从现有环境继续

权威源码在 workspace 的 `repos/super-bot`。先检查 `git status`、当前分支和远端，再修改；不要清理运行数据或另建一个替代项目。

先核对实际 `DSH_HOME`、profile 和宿主所用的 Node。现有 profile 继续用原配置启动。新机器仅需 Web，可按 [安装入门](../README.md#安装本地预览包) 首次初始化。需要验证源码时将构建输出留在 `.runtime`，避免触发正在使用同一工作目录的宿主。

```sh
node --version
SUPER_BOT_BUILD_OUTDIR=.runtime/check npm run check
```

只在确认目标 profile 已以本地 link 加载本仓库、且授权更新对应宿主时使用受保护的 `dev:reload`。以匹配本批构建的 `Applied` 回执核对宿主加载，再查看实际界面。自动监听的 `npm run dev` 仍会写入该工作目录的 `lib/`。命令、首次链接与适用条件见 [热加载说明](development-hmr.md)。

## 下一步优先级

1. 请用户走实际聊天和最终接受；CF-02/03 的正式体验核对、CF-04 的人工确认、SB-15/FV 尚未全部完成。现有实现不需要重新从零开发，不能因交接而勾选最终验收或归档 change。
2. 改善 Bot 自动审查的收尾：现有自动管理轮次有 5 分钟上限，本轮一次代码审查超时，外层提供简短上下文后补交付成功。先复现并判断如何减少重复阅读/保留检查进度，不先取消所有约束或扩建调度系统。
3. 跟踪一次生成重复文本的异常：当时写工具尚未执行，停止并换新 Worker 上下文后恢复；根因未确定，没有 DSH/模型引擎修复结论。
4. 继续打磨命名与列表：当前短名为确定性截短，复杂目标仍可能不够语义化；Workspace 无标题来源，已有分组不自动改名；冷历史不会为整理而被唤醒。没有自动归档，待验收/可返工会话始终保留。

Web 支持范围为 DSH `0.2.2-rc.1` 和 `0.2.2-rc.5`。macOS Desktop `rc.5` 同机配对已有隔离原生 Host 证据，日常原生界面留待实机体验。精确费用归因、独立 App/Web 和云端部署仍后置。

## 继续 dogfooding 的方式

需求、补充和返工从 Bot 主聊天进入，由它使用账本委派 Worker。外层审查文件、检查测试和实际界面，再在空闲时加载。

正在执行的 Worker 会话可以插话引导当前自动轮次，也可以排队下一轮；入队本身不记接管、不打断自动轮次。旧 Run 在自身 turn/end 核对最终报告和后台效果后结算；之后新人工轮次把任务转为 manual，但不会把已 settled 的 Run 改成 interrupted，也不会 cancel 用户这一轮。未知后台效果仍保留恢复核对和资源占用。不要编辑 SQLite 或伪造报告来跳过恢复。

## 数据、证据与发布

源码、测试、脱敏文档可提交。`.runtime`、数据库、会话日志、宿主配置和凭证不提交；不要复制整个 `~/.dsh`。任何密钥都只在宿主或环境变量配置。

成果证据按版本和哈希绑定。新提交保存附件副本，历史无副本成果依赖原路径与原始字节。账本备份包含已保存的成果附件和任务约定快照，DSH 会话与创建端 Markdown 记忆需另行保留。操作见 [备份、恢复与卸载](../README.md#备份恢复与卸载)。

结束当前 Codex 会话不等于停止独立 DSH 宿主。新会话可以直接从本页继续，无需迁移聊天数据库，也无需读取整段旧对话。

2026-11-16：真实隔离宿主插话/续轮/异常/强制重启验证与后续可靠性范围见 [可靠性验证](reliability-verification.md)。本阶段未更新日常 profile，未核对或接受现有任务。
