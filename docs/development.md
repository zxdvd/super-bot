# 修改和验证 Super Bot

## 从症状找到代码

| 用户遇到的问题 | 从哪里查 |
| --- | --- |
| Bot 误解一句话，或者要人去面板操作 | 对照原生消息、实际注册的参数和提示，再看模型选择与命令核对的结果。[动作参数](../src/manager/tool-definition.ts) · [Manager 提示](../src/manager/guidance.ts) · [命令入口](../src/manager.ts) |
| Worker 已收到指示，但任务看起来没推进 | 对照任务版本、Run、原生输入、后台 Job 和当前阶段的回执。[执行适配](../src/dsh.ts) · [原生轮次核对](../src/run-proof.ts) |
| 重试后多了任务、通知或一次外部操作 | 查命令请求 ID、已存回执和实际外部请求次数。[账本命令](../src/store.ts) · [事务与回执](../src/store/transactions.ts) |
| 点开交付物不对，或者收到了多份交付 | 核对原聊天最终回复的任务、成果版本和交付记录，再看渲染器。[交付读回](../src/store/delivery.ts) · [聊天交付入口](../src/ui/ChatDeliveryLinks.tsx) |
| 飞书群中收发状态与 Bot 对话不同 | 沿绑定的群和本人消息查飞书事件、Manager 原生输入及回执。排查建群时还需区分飞书已建群、机器人已入群与本地绑定落账。[消息桥接](../src/feishu-bridge.ts) · [建群与绑定](../src/feishu-groups.ts) |
| 列表说「等你处理」，详情却说 Bot 会自己继续 | 核对当前阻塞项、哪一方能推进和是否已有自动下一步。[工作状态查询](../src/work-activity.ts) · [列表展示](../src/ui/work/format.ts) |

## 本地检查

安装锁文件中的开发依赖，然后从仓库根目录运行：

```sh
npm ci
npm run format:check
npm run lint
SUPER_BOT_BUILD_OUTDIR=.runtime/check npm run check
```

`npm run format` 会写入格式化结果。`npm run check` 包含前两项检查、TypeScript、核心与适配测试以及 Host/Client 构建。日常宿主已链接当前源码时，使用独立构建目录，避免验证中的代码触发热加载。

## 让一条动作可以顺着读下来

从一个管理动作出发，应能找到它的参数、核对依据和实际写入。例如用户选“第二项”时，Manager 负责理解指代，候选记录负责把编号还原为先前展示的对象，命令负责核对当前版本。新动作沿用同一条路径。

格式由 Biome 统一。查询一行代码此前的变更时，可用 `git blame --ignore-revs-file .git-blame-ignore-revs -- 文件路径` 跳过首次全仓格式化。重复跨模块判断时，先找到这份状态的所有者。例如，选择澄清对象时可以列出当前成果，最终验收仍由账本核对同一个版本。长条件用业务名说明判断的事实，遇到异步操作时保留操作之后必要的版本核对。提取模块后，调用方只应需要这个模块实际使用的输入。

## 选择能验证这次改动的入口

| 改动 | 验证 |
| --- | --- |
| SQLite 迁移或重试 | 用旧账本启动并重新打开，核对原 ID 和回执。用同一请求 ID 重试，验证相同请求返回原结果，冲突的请求被拒绝。迁移入口在 [schema.ts](../src/store/schema.ts)。 |
| 聊天操作或提示 | 用同一条原生聊天中的提问、否定、明确授权和上下文选择做对照。检查工具调用、实际任务状态及最终可见回复。[聊天接续验收](../specs/changes/2026-11-chat-task-continuity/evidence.md) |
| 原生轮次、后台 Job 或收发 | 在隔离 DSH 运行 `npm run smoke:chat`、`node scripts/smoke-late-jobs.mjs` 或相应的宿主用例。变更跨重启时检查重启前后的同一任务、同一外部操作及实际调用次数。 |
| 原聊天交付或工作面板 | 从 Bot 对话进入目标任务，验证首要链接、点击效果和状态。在切换会话或轮询后复查。发布到 3080 后，用已登录浏览器核对实际加载的客户端构建。[界面验收入口](../README.md#本地开发预览) |

宿主中的确定性模型可以验证执行链路。验证模型能否理解另一种说法时，应让真实模型读取当前实际注册的提示和工具。记录测试身份、是否真的执行了工具，以及外部服务使用的是测试服务还是真实租户。

验证验收操作时，可以先把实际交付过的 v1 和刚产生的 v2 放在同一个任务里，再让用户说“收下刚才发的”。检查聊天展示的版本和账本最终登记的版本。[聊天交付用例](../test/adapter/delivery.test.ts) · [任务澄清](../test/adapter/p2.test.ts) · [后台 Job 与暂停](../test/adapter/late-jobs.test.ts) · [GitLab 操作回执](../test/gitlab-release.test.ts)
