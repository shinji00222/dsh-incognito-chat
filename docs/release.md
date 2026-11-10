# 发布与版本管理

本文件记录版本号规则、候选版本的验证门槛和本地发布步骤。`CHANGELOG.md` 记录用户可见变化，`docs/test-cases.md` 记录测试证据；两者与 `package.json` 的版本号必须一致。

## 版本号

- 稳定版：`MAJOR.MINOR.PATCH`，正式可用时使用。
- 预览版：`0.1.0-preview.N`，按候选递增；`preview.N` 不是正式发布，桌面验收未完成时不承诺可用。
- 候选构建必须使用新版本号，避免 pnpm 复用同版本号的旧 tgz。

## 候选版本检查

1. `npm test` 全部通过；新增行为补进 `tests/` 和 `docs/test-cases.md` 的 A 编号。
2. `node scripts/verify-session-log-request.mjs`、`--negative-control` 通过；必要时补跑 `scripts/verify-session-log-installed.mjs`、`scripts/check-isolated-status.mjs`。
3. 在隔离 DSH_HOME 打包并安装候选 tgz，确认自检 `ready=true`；不修改真实 desktop profile。
4. 真实 desktop 回归按 `docs/test-cases.md` 的 M01–M14 逐项记录；不同版本的通过结果不能拼接。
5. 检查待提交内容不含凭据、个人信息、真实对话和测试资料；`work/`、`artifacts/` 保持未跟踪。

## 打包与版本记录

```sh
npm test
npm pack --pack-destination artifacts
```

- 产物：`artifacts/<name>-<version>.tgz`，记录文件名、大小和 SHA-256。
- 更新 `package.json` 的 `version`、`README.md` 安装命令中的文件名、`CHANGELOG.md` 的版本段。
- 提交后打本地 annotated tag：`git tag -a v<version> -m "<version> candidate: <summary>"`。
- 推送提交和 tag 需要单独授权；tag 未推送时只在本机生效。2026-11-09 已授权并推送 preview.11 候选。

## 当前候选记录

- 版本：`0.1.0-preview.12`（2026-11-10 本地候选）
- 产物：`artifacts/dsh-incognito-chat-0.1.0-preview.12.tgz`，27,946 字节，SHA-256 `b278fd7c0a0ba98dbbbc5301c6641526e62c22da111cb959feeb3604ada97b00`
- 安装包验证：官方 CLI 安装到全新隔离 web profile，实际加载 `preview.12`；自检 `ready=true`，各保护项均为 `ok`
- 同版本源代码验证：`npm test` 76/76；M10 正向与反向对照、M11 普通与无痕的本地及外部服务入口对照均通过
- 安装包追加实测：锁定旧附件时启动仍为 `ready=true` 并报告延期清理，释放锁后重启成功删除旧目录
- 打包后新增 M12 界面提示修复，隔离 web 源码复验通过，需使用新版本号打包
- 桌面现状：本机仍使用 `preview.11`。`preview.12` 的桌面回归、tag 和发布待办

## preview.11 候选记录

- 版本：`0.1.0-preview.11`（候选，未发布；2026-11-10 已安装到本机 desktop）
- tag：`v0.1.0-preview.11`（指向候选提交 bffb3cd；已推送）
- 推送：`main` 与 tag 已推送到 origin（2026-11-09）
- 产物：`artifacts/dsh-incognito-chat-0.1.0-preview.11.tgz`，27,627 字节，SHA-256 `1bfdf1cd2d7b72e2c61f1028d911566ed165d4d3e6fe67e58a46ff77fd2b61b2`
- 隔离验证：M10 请求链路普通/无痕对照与负向对照通过；M11 真实子 Agent 服务入口验证连续 3 次通过（无痕父会话被拒且无子会话文件，普通父会话同一入口创建子会话并落盘）；候选 tgz 装入 `work/candidate-preview11-final/home` 后 `ready=true`，persistence/projectionCache/sessionLog/subagentGuard/attachments 全 `ok`
- 自动测试：2026-11-10 在 `ecbc40b` 上复跑 `npm test` 75/75 通过
- 桌面验收：无痕开关、文本和草稿对照、TXT/PNG 选择、PNG 粘贴、删除及正常重启清理已验证。详见测试清单；拖放、异常退出、真实服务商请求字段、模型调用 `subagent` 工具和外部 provider 路径待验
- 回退：已备份桌面 profile 配置和锁文件；需要时通过旧 preview.10 安装包恢复并重启 DSH
