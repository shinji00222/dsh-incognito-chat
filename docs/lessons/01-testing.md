# 第 1 课：怎么测试一个「不落盘」的插件

> 给 shin。读完动手做最后的练习。

## 1. 两种测试，各管一件事

| | 单元测试 `npm test` | 端到端验证 `verify-no-trace` |
|---|---|---|
| 测什么 | 一小段代码的逻辑对不对 | 整个插件装进真 DSH 后，磁盘上到底有没有留痕 |
| 快不快 | 0.1 秒 | 要启动 DSH、真聊天，几分钟 |
| 需要 DSH 吗 | 不需要，用假对象 | 需要 |
| 能发现 | 分流写错、seq 跳号、还原失败 | cordis 代理吞赋值、接口 404、localStorage 留痕 |

这次开发里，**单元测试全绿的时候，端到端还挂了 4 次**（见 `技能.md` 的坑 1–4）。两种都要有。

## 2. 单元测试怎么读：准备 → 动作 → 断言

打开 `tests/persistence.test.mjs`，看「无痕会话不碰 JSONL」这一条：

```js
const jsonl = fakeJsonl()                 // 准备：一个假的 JSONL，记下 create 被谁调过
wrapPersistence(jsonl, store)

const handle = await jsonl.create({ id: INCOGNITO_ID })   // 动作

assert.deepEqual(jsonl.created, [])       // 断言：JSONL 一次都没被调用
```

关键思路：**不启动 DSH，而是造一个假的 JSONL**。它不写盘，只记账。只要无痕会话没走到它，就证明真实情况下也不会走到真 JSONL。这叫「测试替身」（test double / fake）。

## 3. 验证「没发生的事」最容易犯的错

「我搜了一遍，没找到探针文字，所以没留痕。」—— 这不够。万一你的搜索方法本身就搜不到呢？

所以要做**对照组**：用同一个方法，在一定会留痕的地方（普通对话）搜一次，必须能搜到。

这次的真实结果：

```
无痕对话：node scripts/verify-no-trace.mjs check INCOG-PROBE-7f3a  → PASS
普通对话：node scripts/verify-no-trace.mjs check NORMAL-PROBE-9c1e → FAIL（在投影缓存里找到了）
```

普通对话能被抓到，无痕对话的 PASS 才有说服力。

还有一个更隐蔽的陷阱（这次真踩了）：会话日志是 zstd 压缩的，而且是**很多帧拼在一起**。Node 的 `zstdDecompressSync` 只解第一帧，解出来只有表头。

如果没有对照组，我会得出「压缩日志里没有探针 → 无痕成功」—— 但其实是**根本没搜到内容**。是对照组（普通对话里一定有的探针也搜不到）暴露了这个 bug。修好以后，对照组在压缩日志里能找到探针，无痕的 PASS 才可信。

## 4. 一个好测试要能失败

写完测试，故意把代码改坏，看它会不会变红。不会变红的测试等于没写。

## 练习（在 `tests/ids.test.mjs` 里）

1. 把 4 个 `test.todo` 改成真正的 `test`，跑 `npm test` 看它们变绿。
2. 然后打开 `src/host/ids.js`，把正则里的 `^` 删掉，再跑一次 —— 你写的哪条测试变红了？为什么？改回来。
3. 思考题：为什么 `isIncognito` 宁可漏认也不误认？（提示：误认会让什么事情发生？）

写完告诉我，我帮你看。
