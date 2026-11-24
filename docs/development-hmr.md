# 本地开发热加载验证

## 从设置重载本端 Super Bot

Web 和 macOS Desktop 可以共用一份源码。为每个本地 DSH profile 首次准备自己的开发包，源码目录需长期保留，构建依赖通过 `npm ci` 安装。以已有的 `web` profile 为例，在源码根目录、该 profile 的 `DSH_HOME` 环境中执行：

```sh
node scripts/dev-profile-package.mjs web
```

命令在源码目录下生成该 profile 专属的构建目录，输出一个完整的 `link:…`。再次运行会返回相同路径。等本端 Bot 和后台工作空闲，正常退出该端，运行 `dsh plugin --profile web add "link:上一步输出的绝对路径"`，然后启动原 profile。Desktop 使用相同源码，将两条命令的 profile 参数换成 `desktop`，使用 Desktop 对应的 DSH home。每个链接只供生成它的 profile 使用。

进入「Super Bot → 设置」，勾选「启用本端插件开发」。开关写入当前 profile 的 `super-bot.json` 顶层 `developerMode`，默认关闭。修改本地源码后点击「重载本端 Super Bot」。本端会申请空闲许可、暂存构建、发布到本端目录，并在原设置页核对 Host 和当前窗口的构建号。Web 与 Desktop 可在不同时间试用同一修改。插件内未保存的表单可能在重新挂载时重置。

有活动时，设置页显示阻塞项，等工作结束再点。后端已更新而窗口尚未加载时会显示等待状态。若显示「结果待核对」，可先打开 DSH 的 Plugins 和宿主日志检查。包版本、依赖声明或 Cordis 补丁变更时，先退出该端，将之前输出的包目录移到备份位置，再运行准备和安装命令。共享依赖升级前，两端都应空闲并退出。原有 `dev:reload` 命令可继续用于独立开发包或原 checkout 链接。

## 原生重载机制与验证

2026-11-08，DSH Web `0.2.2-rc.1`、Node `24.21.0`。

DSH 已提供 [Host HMR](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/hmr/README.md) 和 [Client HMR](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/hmr/README.md)。本项目复用这些机制，不实现另一套插件加载器。

DSH Web `0.2.2-rc.1` 和 `0.2.2-rc.5` 均要求 Node `>=24.9.0`。从用于构建和启动宿主的终端执行 `node --version`。用 fnm 时，可在当前终端执行 `fnm use 24.22.1`。已运行的旧 Node 宿主需要等 Bot、Worker 空闲后正常退出，再用兼容的 Node 版本启动原 profile。

- `npm run dev` 使用独立 `.runtime/dsh-dev` home 和 `super-bot-dev` profile，并在本工作目录的 `lib/` 持续写入构建。请在同一 `lib/` 未被其他宿主使用时运行。默认端口 3081，可通过 `SUPER_BOT_PORT` 修改。
- `npm run dev:reload`（DF-09）先向已链接的活插件取得许可，再暂存构建。HTTP 请求只登记提交并写入该实例的私有触发文件。`hmr.watchConfig()` 把回调送入下一次原生 HMR 事务，由回调复核许可、发布产物并调用 `hmr.reconcileProfile(['super-bot'])`。`Applied` 回执需要旧实例清理完成，以及同进程新实例识别到本次构建标识。首次启用、等待和取消用法见 [本地开发预览](../README.md#本地开发预览)。
- Web 默认 Host HMR 的 `root: []` 只监听配置；手动路径不自动监听后端源码。Client HMR 自动发现前端构建文件变化并发出 rebuilt 通知。
- 正式发布仍使用带版本的 tgz；本地迭代不需要升版本或重新打包。共享框架/宿主依赖发生变化时，仍以 DSH 的 restart-required 诊断为准。

2026-11-08 实际隔离验证（当时的 `dev:reload` 仍写 profile patch）：

1. 最小插件以本地 link 启动，改变 `lib/index.js` 中 API 返回的 marker。约 526 ms 后观察到新 marker 和新挂载时间，PID 相同、版本仍为 `0.0.0`。
2. 同版本 tgz→link 切换后，仅触碰配置失败；阅读当前安装的 HMR 实现确认其比较配置内容。改变一行 YAML 注释后 API 返回新 marker，PID 相同，没有宿主重启。
3. 用 `npm run dev` 的真实 Super Bot 验证：后端构建文件变化后 status 的 startedAt 改变、version 保持 `0.1.3`；前端构建文件变化后 `/plugins/events` 收到本插件的 rebuilt SSE。没有将 SSE 事实夸大为浏览器 React 状态保留。
4. 使用独立 profile 启动真正的 `0.1.3` tgz，执行实际 `scripts/dev-reload.mjs`。状态端点前后均正常，版本仍为 `0.1.3`、startedAt 改变，同一宿主 PID 存活，manifest 依赖变为仓库本地 link。没有修改日常 profile 或正在运行的 Worker。
5. 测试开发宿主退出后，确认其 Host 和构建监听子进程全部退出。

首次无模型配置的开发启动额外暴露了 Schema 默认对象展开的问题：省略 managerModel/workerModel 仍要求 provider。已让整个角色模型覆盖可省略，同时继续拒绝不完整的显式选择；三项角色配置测试和 typecheck 通过，真实隔离宿主恢复激活。

原始合成探针、私有宿主日志和 JSON 结果仅保存在忽略的 `.runtime`。2026-11-21 DF-09 的定向回归、接口依据和日常宿主活验状态见 [研究证据](../specs/changes/2026-11-super-bot-mvp/evidence.md)。
