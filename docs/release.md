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
- 推送提交和 tag 需要单独授权；tag 未推送时只在本机生效。

## 当前候选记录

- 版本：`0.1.0-preview.11`（候选，未发布，未安装到真实 desktop）
- tag：`v0.1.0-preview.11`（指向包含本记录的候选提交）
- 产物：`artifacts/dsh-incognito-chat-0.1.0-preview.11.tgz`，27,627 字节，SHA-256 `1bfdf1cd2d7b72e2c61f1028d911566ed165d4d3e6fe67e58a46ff77fd2b61b2`
- 隔离验证：M10 请求链路普通/无痕对照与负向对照通过；候选 tgz 装入 `work/candidate-preview11-final/home` 后 `ready=true`，persistence/projectionCache/sessionLog/subagentGuard/attachments 全 `ok`
- 自动测试：`npm test` 69/69 通过
- 未做：真实 desktop 安装与 M01–M14 桌面回归、真实服务商请求、真实子 agent 路径
- 回退：真实 desktop 仍引用 preview.10；安装候选前保留 profile 备份，失败时恢复旧 tgz 引用并重启 DSH
