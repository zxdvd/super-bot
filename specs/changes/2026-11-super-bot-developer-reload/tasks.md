# 任务与验证

- [x] DR1 在现有设置页保存 profile 级开关。验证缺省、旧配置迁移、字段保留及禁用时拒绝 API。
- [x] DR2 为同一源码生成分端独占的包，使用原生许可暂存、发布、接棒。验证共享目录拒绝、双端隔离、忙碌、失败与连续重载。
- [x] DR3 跨插件重新挂载显示当前窗口回执，保留飞书设置。验证客户端构建号、浏览器设置操作与飞书在途保护。
- [x] Final Verification 全量 npm run check，隔离 Web 与原生 Desktop 窗口分别点击，核对同进程、原聊天及对端连续性。

## 2026-11-24 验证记录

- Node 24.22.1 的 `npm run check` 通过。包含行数检查、类型检查、120 项核心及 SDK 测试、325 项适配测试和 Host/Client 构建。
- 在独立 home/profile 启动 Web rc.1、Web rc.5，各与 macOS Desktop rc.5 原生 Host 组成一组。两组均使用确定性模型及 Chromium。从设置点击重载，Desktop 有活动 Worker 时拒绝，Web 连续发布两次，原 Worker 仍在原轮次，对端 JS 哈希未变。释放 Worker 后 Desktop 连续两次发布成功。每次核对新实例回执、页面构建号、原管理聊天的归属和任务内容。隔离产物位于本 worktree 的 `.runtime/worker-web1/proof.json` 和 `.runtime/worker-web5/proof.json`。
- 单独启动已安装的 macOS Desktop rc.5 应用，将 DSH home、Electron user-data 及 HOME 指向隔离目录。在原生应用窗口的设置里点击按钮，当前窗口显示新构建回执。开发设置持久化，日常 profile 未参与验证。
- 重跑双端烟测时配置 `SUPER_BOT_TEST_PLAYWRIGHT`（Playwright 模块入口绝对路径）和 `SUPER_BOT_TEST_BROWSER`（Chromium 可执行文件），执行 `SUPER_BOT_TEST_DEVELOPER_RELOAD=1 node scripts/smoke-mirror.mjs`。可用 `SUPER_BOT_TEST_WEB_ENTRY` 指向另一受支持的 DSH CLI。原生窗口验证需另外启动隔离 Desktop 应用，使用该 profile，在设置中点击，确认新构建号出现在同一窗口。
