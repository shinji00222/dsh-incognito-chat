# dsh-incognito-chat

给 DeepSeek Harness 加一个无痕对话，用起来跟 Claude 的无痕模式差不多。

新建对话页「标准模式」那一行会多一个 **无痕** 开关。打开以后就是一个普通对话：照样流式输出、调工具、走审批，区别是：

- 会话内容一直放在内存里，**不会写进 `~/.dsh/sessions`**（是根本不写，不是写完再删）
- 不进历史列表，标题、用量这些缓存也不写
- 侧栏里会标出无痕对话；不想要了就手动删除，退出 DSH 也会直接消失

## 安装

还没发 npm，先本地装：

```sh
npm pack
dsh plugin --profile web add ./dsh-incognito-chat-0.1.0-preview.3.tgz
```

需要 DSH 0.2.1 左右的版本。插件启动时会自检，内部接口对不上就把开关变灰，不会假装在无痕。

## 管不到的地方

- 消息还是会发给模型服务商，这是对话本身决定的
- Agent 用工具改过的文件不会撤销
- 对话开着的时候，`workspace.json` 里会临时记下这个会话的 id（只有 id，没有内容），离开时删掉；DSH 崩了的话，下次启动时清掉
- 粘贴的图片和附件目前还会存到 `~/.dsh/attachments`，下个版本处理
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
