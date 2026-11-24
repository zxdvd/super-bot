# 开发者模式与本端手动重载

Status: verifying
Scope: repo · standard
Context: super-bot
Created: 2026-11-24

Web 和 macOS Desktop 需要从一份源码独立试用更新。两端链接同一个 lib 时，Client HMR 可能先替另一端更新界面。

在 Super Bot 首页设置增加开发者模式，保存到本 profile 的 super-bot.json 顶层 developerMode，默认关闭。为每个 profile 准备专属 link 包。设置按钮从固定源码构建，向本端原生 HMR 提交，当前窗口核对同批构建号。保留原有 CLI。范围限于本地 Super Bot；安装、共享依赖升级和第三方插件管理继续走 DSH 的已有流程。

## 验收

- 关闭时 API 拒绝启动。开启后立即可用；保存飞书与开发设置不丢字段。
- 只对当前 profile 发布构建；共享 checkout、安装包、未就绪 HMR 显示原因。
- Worker、Manager、Job、飞书在途工作或自测阻止发布。失败可定位，发布结果不明时如实呈现。
- 同 PID 新实例与当前窗口显示相同构建号才报成功。热重载前后的聊天、任务及其他宿主连续。

[任务与验证](tasks.md)
