# dsh-incognito-chat

给 DeepSeek Harness 加一个无痕对话，用起来跟 Claude 的无痕模式差不多。

新建对话页「标准模式」那一行会多一个 **无痕** 开关。打开以后就是一个普通对话：照样流式输出、调工具、走审批，区别是：

- 会话内容一直放在内存里，**不会写进 `~/.dsh/sessions`**（是根本不写，不是写完再删）
- 不进历史列表，标题、用量这些缓存也不写
- 侧栏里会标出无痕对话；不想要了就手动删除，退出 DSH 也会直接消失

## 演示

![普通对话与无痕对话演示](docs/demo.gif)

[观看视频版](docs/demo.mp4)（无声，约 39 秒）。演示使用隔离的 DSH 环境和本地模拟回复，展示普通对话与无痕对话、会话文件数量对照，以及删除无痕会话。

## 安装

还没发 npm，先本地装：

```sh
npm pack
dsh plugin --profile desktop add ./dsh-incognito-chat-0.1.0.tgz
```

需要 DSH 0.2.1 左右的版本。插件启动时会自检，内部接口对不上就把开关变灰，不会假装在无痕。

## 管不到的地方

- 消息还是会发给模型服务商，这是对话本身决定的
- Agent 用工具改过的文件不会撤销
- 对话开着的时候，`workspace.json` 里会临时记下这个会话的 id（只有 id，没有内容），离开时删掉；DSH 崩了的话，下次启动时清掉
- 桌面附件使用期间会写入会话临时目录，删除会话时清理。清理不保证磁盘上的旧数据无法恢复
- 手动输入 `@` 引用文件时，工具可能直接读取原文件，不会删除或保护那个原文件
- 无痕对话暂不支持启动子 agent 或创建子会话
- DSH 异常退出后，下次启动会清理旧附件目录。脱离 DSH 管理的进程若在清理后才按路径读取附件，可能找不到文件
- Windows 上旧附件被进程锁定时，插件会记录延后清理的警告，并在下次启动时重试
- 无痕会话会拦截 `session-log-deepseek` 的额外日志字段；真实桌面请求及子会话路径尚未完整验证，其他插件也可能收集或发送内容
- 旧版本曾将未发送的无痕草稿写入浏览器存储，升级不会擦除底层日志中的旧数据

## 怎么验证

```sh
npm test                                         # 单元测试
node scripts/install-isolated.mjs                # 装进隔离的 DSH_HOME（work/isolated-dsh）
node scripts/serve-isolated.mjs                  # 启动隔离的 DSH web
node scripts/verify-no-trace.mjs snapshot        # 开无痕之前拍快照
node scripts/verify-no-trace.mjs check <探针文字>  # 聊完离开后检查
```

## License

MIT
