# 测试用例与回归记录

本清单汇总截至 2026-11-06 的现有自动测试和 `技能.md` 中的验收记录，供后续迭代使用。历史结果只适用于当时记录的版本和环境，不代表当前版本已重新通过。每次修改后按影响范围执行相关用例；发布前执行完整自动测试和适用的桌面回归。

## 怎么记录新用例

记录场景、准备和操作、预期、实际结果、版本与环境、日期和证据位置。结果标为“通过 / 失败 / 未验证”，有部分证据时写明实际覆盖范围。发现缺陷时先记录复现步骤；修复后尽量补自动回归，并保留普通会话对照。

检查隐私使用不含真实隐私的独特探针；普通对话使用不同探针，确认检查方法能发现预期落盘内容。没发现探针只说明所检查的路径和方法内没找到，不代表全盘无痕，也不代表安全擦除。

## 自动回归用例

运行 `npm test`。下表列的是当前测试代码覆盖的行为，不等于真实 DSH 桌面全链路已验证。对应文件可用 `node --test tests/<文件名>.test.mjs` 单独运行。

| 编号 | 场景与预期 | 测试文件 |
|---|---|---|
| A01 | 只识别格式正确的无痕 ID；普通、格式错误及非字符串输入不误认；生成的 ID 可识别 | `tests/ids.test.mjs` |
| A02 | 无痕会话走内存，不调用普通持久化；普通会话照常写入；重复创建、恢复、代理调用与包装失败有明确行为 | `tests/persistence.test.mjs` |
| A03 | 内存会话事件序号、读取范围、关闭清空及后续操作符合预期 | `tests/persistence.test.mjs` |
| A04 | 无痕投影缓存不写入，普通会话照写；内部接口缺失时报告失败 | `tests/projcache.test.mjs` |
| A05 | 工作区只移除指定或全部无痕 ID，保留普通会话；异常 registry 不崩溃 | `tests/workspace.test.mjs` |
| A06 | 按可用生命周期释放会话；找不到时如实返回，且不影响其他会话 | `tests/release.test.mjs` |
| A07 | 无痕草稿留在内存，普通草稿和 sessionStorage 行为保持；保护失效能检测 | `tests/draft-guard.test.mjs` |
| A08 | 会话归属跨并发、延迟异步流和模型调用保持正确 | `tests/attachment-context.test.mjs` |
| A09 | 附件入口按会话分流；归属不明拒绝写入或执行；入口缺失时撤销已安装补丁；普通工具不变 | `tests/attachment-hooks.test.mjs` |
| A10 | 同内容的不同无痕会话使用独立目录；关闭等待已开始操作，拒绝关闭后的新操作和过期上下文 | `tests/temporary-attachments.test.mjs` |
| A11 | 删除等待附件保存、登记及工具读取结束；已运行工具可完成，新工具被拒绝；失败时释放等待 | `tests/attachment-store-pool.test.mjs` |
| A12 | 删除等待所属后台生产者；状态异常、未结束或无法取得完成句柄时拒绝清理；归属错误拒绝启动；普通任务不受影响 | `tests/attachment-jobs.test.mjs` |
| A13 | 桌面无痕选择、拖放、粘贴文件转成无宿主路径副本；普通会话不变，未知归属或目录被拒绝 | `tests/desktop-file-guard.test.mjs` |
| A16 | 无痕父会话启动子 agent 或创建子会话时拒绝；普通会话仍能调用原方法 | `tests/subagent-guard.test.mjs`、`tests/persistence.test.mjs`；隔离真实服务验证 `scripts/verify-subagent-guard.mjs`（见 M11） |
| A15 | 无痕请求不准备额外会话日志，普通请求和其他字段不受影响；覆盖先注册和后注册 | `tests/session-log.test.mjs`；`node scripts/verify-session-log-installed.mjs` 使用本机 DSH 的提供者与注册表做合成对照 |
| A17 | 请求层判定：普通对照必须带 `dsh_session_log` 且含本轮探针；无痕不得带该字段、但消息仍在；普通对照缺字段必须失败 | `tests/session-log-request.test.mjs` |
| A18 | 后台任务与删除的事件顺序：任务使用附件期间不清理，任务结束后才清理；结束状态无法确认时保留附件 | `tests/attachment-lifecycle-order.test.mjs` |
| A14 | 启动清理只处理已退出进程的插件目录，保留活动进程及未知目录 | `tests/attachment-crash-cleanup.test.mjs` |

A14 验证的是现有父进程判断逻辑，不证明已退出的 DSH 没有脱离的子进程仍在使用附件。

## 真实环境回归清单

历史证据来自项目 `技能.md` 的验证记录及“2026-11-06 当前续接”。版本号不同的结果不能合并成某一版本的完整验收。

| 编号 | 操作与预期 | 已有记录 | 待补 |
|---|---|---|---|
| M01 | 无痕发消息、调工具、切换后返回并删除；内容不进入会话存储，普通对照能被检测 | preview.2 真实 desktop 有记录；隔离环境有真实模型和普通对照 | 更新后重新回归；检查范围不覆盖全盘 |
| M02 | 输入未发送无痕草稿、关闭后检查浏览器存储；普通草稿对照仍可恢复 | preview.3 真实 desktop 未在所查 localStorage 文件找到合成草稿探针；旧版曾留下明文 | 新版本再验证；不能据此断言旧数据库字节被擦除 |
| M03 | 无痕选择 TXT，发送并由工具读取；临时目录隔离，删除后清理 | preview.5 和 preview.10 真实 desktop 有记录 | 新版本回归，检查普通对照 |
| M04 | 选择 PNG 并由模型读取；无痕图片不进入普通附件目录 | preview.6 真实 desktop 有记录 | 新版本回归 |
| M05 | 从资源管理器复制 PNG 文件并粘贴，发送后模型读取 | preview.6 真实 desktop 有记录 | 其他截图应用的剪贴板格式未覆盖 |
| M06 | 拖入 PNG，模型读取；检查普通附件目录及删除后的临时目录 | preview.8 真实 desktop 有记录 | 新版本回归 |
| M07 | 同图用于普通和两个无痕会话；删除一个无痕会话后其他会话仍可预览 | preview.8 真实 desktop 有记录 | 新版本回归；不要删除仍被普通会话引用的对象 |
| M08 | 后台任务延迟读取附件，运行中删除会话；任务仍需要文件时不得提前清理 | preview.10 真实 desktop 用约 50ms 采样观察到进程和文件从同时存在变为同时不存在 | 采样不能证明严格先后；自动测试 A18 已用事件顺序覆盖任务结束前后与失败路径；真实桌面并发读写、删除时序仍需验证 |
| M09 | 无痕附件存在时异常退出，再启动并检查残留清理 | preview.6 真实 desktop 强制退出后重启，旧进程目录移除 | 未覆盖活跃的脱离型子进程；不能证明其已停止 |
| M10 | 检查实际模型请求，区分正常消息与额外会话日志；普通会话作对照 | 2026-11-07：本机 DSH 的真实日志提供者和注册表隔离验证，修改前无痕字段含合成探针；修改后无痕字段为空、普通对照仍含探针。隔离 DSH 加载新包后 `sessionLog: ok`。2026-11-09：隔离 DSH_HOME + 本地 Messages 模拟端，走真实 host 请求组装和 HTTP 发送链路；普通请求带字段且含探针，无痕请求不带字段但 messages/system 仍在；普通对照缺字段时脚本判失败。见下方「M10 隔离请求链路验证」 | **未验证**真实桌面及真实服务商的网络链路；子会话路径改由 preview.11 的子 agent 拒绝保护覆盖（M11），本验证未实测真实子会话和真实接受水位。此验证使用隔离 profile 和模拟接收端 |
| M11 | 检查脱离生产者 Promise 的进程或跨会话子 agent 仍使用附件时的删除、崩溃和重启行为；并验证无痕父会话不能启动子 agent | 2026-11-09 静态检查：本机 DSH 默认给子 agent 普通 UUID；候选版在启动入口和持久化入口增加拒绝保护，隔离服务报告 `subagentGuard: ok`，单元测试通过。同日隔离真实服务验证：无痕父会话 `startActivation` 被拒且 sessions 无新增文件，直接 `persistence.create` 被拒；普通父会话同一入口成功创建子会话并落盘，`parentSession` 正确；连续 3 次 PASS。见下方「M11 隔离子 Agent 服务验证」 | 本验证只覆盖 in-process `spawn` 的 `startActivation` 服务入口，未走模型调用 `subagent` 工具的参数解析/预设路径；外部 provider（ACP 等）及子进程、真实 desktop 和附件生命周期仍未覆盖 |
| M12 | 自检失败时无痕开关不可用并提示；普通功能不受影响 | 2026-11-10 隔离 web UI：preview.11 仅在悬浮属性显示故障提示；preview.13 安装包正常/故障对照通过，原因可见且关联禁用开关，普通会话收到本地模拟回复 | 真实桌面故障界面待验 |
| M13 | 会话关闭时有延迟写入，确认完成关闭和清理后目录不会重新出现；清理失败要如实提示，普通会话不受影响 | 2026-11-09：自动测试中，受控附件延迟写入完成后才清理，清理后新操作被拒绝；目标异常时清理报错；延迟会话事件不会恢复内存或写入普通日志。另一个无痕附件与普通日志对照正常。灵感来自 [dsh-incognito 延迟清理实现](https://github.com/HuiHuitie-zhu/dsh-incognito/blob/main/lib/index.js) | **部分验证**：尚未覆盖真实 DSH 桌面、用户界面错误提示、脱离受控生命周期的外部进程及直接重建目录 |
| M14 | 候选安装包在隔离 DSH_HOME 用官方 plugin CLI 安装并启动，自检 status 各子系统为 ok | 2026-11-09：`artifacts/dsh-incognito-chat-0.1.0-preview.11.tgz` 装入 `work/candidate-preview11-final/home`；`node scripts/check-isolated-status.mjs --home work/candidate-preview11-final/home` 输出 `ready=true`，persistence/projectionCache/sessionLog/subagentGuard/attachments 全 `ok`；真实 desktop 未安装 | 真实 desktop 安装、重启和桌面回归仍未做 |

2026-11-09 复核：验证脚本拒绝重复或无法唯一归属的请求，运行目录必须是 `work/` 下不存在的直接子目录；新增防回归测试。实际验证仍以脚本运行期间捕获到的请求为范围。

### 2026-11-10 preview.11 桌面验收进度

- 使用 M14 记录的候选包升级真实 desktop。新建会话可以开启无痕，侧边栏和会话顶部显示无痕标识，合成文本收到模型预期回复。发送后检查普通 `sessions` 下的 83 个文件，包括可解码的 zstd 数据，没有发现探针或无痕 ID 路径。
- TXT 通过原生选择器加入无痕会话，模型返回附件中独有的合成探针。探针出现在无痕临时附件目录的两个文件中，普通附件目录检查的 46 个对象中未发现匹配。
- 删除 TXT 测试会话后，侧边栏条目和对应临时附件目录均已消失。读取 84 个普通 sessions 文件（含可解码 zstd 数据），普通对照探针命中一个文件，三条无痕探针均未命中。
- 未发送的无痕草稿已显示在编辑区。对桌面 Local Storage 的 6 个可读文件搜索 UTF-8 和 UTF-16LE 字节，无痕探针未命中，普通草稿探针命中一个文件。有 1 个文件未能读取。
- PNG 从文件选择器及资源管理器复制后粘贴，两条路径都能发送并得到图片中的合成探针。两次都在无痕临时附件目录匹配到原图哈希，普通附件目录没有匹配。
- 文件选择器路径的 PNG 无痕会话保留到正常退出。进程退出后对应临时目录消失，重启后无痕会话未恢复，普通对照会话的消息和未发送草稿均恢复。
- 拖放、真实桌面故障提示和真实服务商请求字段待验。

### 2026-11-10 隔离强退与故障注入

- M09/M11：用独立的 `DSH_HOME` 和临时根启动真实 DSH 运行时，在插件创建的进程目录内放入合成附件。单独启动一个模拟外部读取进程，强制停止隔离 DSH。附件在强退后仍在；重启时插件报告 `ready=true`，旧目录被清理。模拟读取进程仍存活，再读同一路径返回 `ENOENT`。这证明现有启动清理会按旧 DSH 进程退出处理目录，无法保留仍被独立进程使用的附件。此探针未通过 DSH 创建实际后台任务，未验证 DSH 外部 provider 是否会产生这类进程。
- M12：在另一套隔离临时根中，用合成普通文件占据附件根目录的位置。真实状态接口报告 `ready=false`、`attachments=failed`，`persistence`、`sessionLog`、`subagentGuard` 均为 `ok`。此项覆盖后端故障状态，桌面按钮和提示仍待验。
- M09/M11 受管理任务对照：在隔离 DSH 中给无痕会话加载标准预设，通过真实 `jobs.start` 和 `shell.execute` 启动后台 PowerShell。用文件信号确认它读取了插件进程目录中的合成附件后，再强退 DSH 宿主。附件当时还在，PowerShell 在重启前已退出。重启后旧目录清理成功，任务进程仍未运行。本次覆盖 Windows 默认 `workspace-write` 下的受管理 PowerShell；模型工具入口、其他沙箱模式、外部 provider 和真正脱离管理的进程未覆盖。
- M09/M11 受管理子进程对照：在 Windows 上运行 `node scripts/verify-managed-crash.mjs`。探针由受管理 PowerShell 再启动一个 PowerShell 子进程，等待子进程读到合成附件后强退宿主，检查两级进程均在重启前退出，并在重启后检查旧附件目录已移除。隔离实测通过。该命令在项目 `work/` 下创建独立的配置、工作区和临时目录。
- M11 外部 provider 启动边界：`node scripts/verify-subagent-guard.mjs` 额外注册一个只有 `start` 的合成 provider，走真实 DSH 的外部分支。无痕请求在 provider 启动前被拦截，启动回调调用数为 0；普通对照到达回调 1 次，以预定错误标记结束。无痕测试窗口内会话文件仍为 0 → 0。该探针只验证启动边界，未启动真实 ACP/SDK provider，未覆盖模型工具入口或附件传递。
- M09 锁定旧附件：隔离强退后由独立 PowerShell 独占打开合成附件。修复前，重启报告 `attachments=failed`、`ready=false`；修复后，同一条件下报告 `attachments=ok`、`ready=true`，并记录延后清理警告。释放文件后再次重启，旧目录成功清除。Windows 回归用例同时验证其他可清理的旧目录不受阻。
- M09/M11 追加对照：`node scripts/verify-managed-crash.mjs` 和 `node scripts/verify-managed-crash.mjs --full-access` 分别断言实际解析出的 Shell 模式为 `workspace-write` 和 `danger-full-access`。本机两种模式均实测到后台 PowerShell 及其后代在重启前退出，旧附件目录在重启后消失。安装版的普通 Windows 子进程在 Job runner 不可用时仍有较弱的回退路径，本机两组结果不覆盖该回退、ConPTY 或进程树之外的读取者。
- M12 界面复验：在两套隔离 DSH web 环境测试正常和附件目录被占用。正常开关可进入无痕；故障开关禁用，页面显示「无痕附件初始化失败，请检查 DSH 日志」，通过 `aria-describedby` 关联开关，前端没有展示异常路径。故障环境中普通会话仍收到本地模拟回复，前后 `liveSessions=0`。REA 故障页面证据 `ev_911f5778d20fef5d81cf704f7b926bccc34095917120a7250d5bbc5c31f75d8c`；普通回复与正常开关由 Playwright 单独复测。
- 同次复跑 `npm test` 75/75，M10 正向请求对照和 M11 进程内子 Agent 服务对照通过。

### M10 隔离请求链路验证（2026-11-09）

目的：补上只验证提供者和注册表之外的缺口，确认经过真实 DSH host 组装并实际发送的请求里，普通会话带 `dsh_session_log`、无痕会话不带该字段，而且无痕对话本身仍按正常消息发送。

做法：

- 脚本：`node scripts/verify-session-log-request.mjs`；判定逻辑在 `scripts/lib/session-log-request-check.mjs`，纯判定单元测试在 `tests/session-log-request.test.mjs`。
- 每次新建隔离目录 `work/session-log-request-<时间戳>/`：独立 `DSH_HOME`、独立 workspace、独立日志和抓包；不读取也不改动真实 desktop profile。
- 隔离 web profile 直接装入当前工作树的 `src/` 和探针插件 `scripts/fixtures/session-log-m10-probe/`；探针在 host 内用真实 Agent 链路创建 `session-<uuid>` 和 `session-incognito-<uuid>` 两个会话，各发一条合成消息。
- 模型端点通过隔离 profile 的 `llm-deepseek.baseURL` 指向本地 `127.0.0.1` 模拟服务；请求里只出现合成内容。API key 使用本地假值，模拟端只记录请求体，不记录 header、Cookie 或凭据；日志中的 web token 和 `sk-` 串会打码，隔离 home 启动时生成的浏览器会话 grant 在运行后也会打码。
- 模拟服务对 `/messages` 返回固定的合成 SSE，让回合正常结束；`session-title-llm` 和 `session-telemetry-otel` 在隔离 profile 中关闭，避免额外请求干扰。
- 判定：普通请求必须有 `dsh_session_log` 且字段内含普通探针；无痕请求必须没有该字段，但 `messages` 必须含无痕探针；任何一侧缺失都直接失败。普通对照缺字段时脚本以 `CONTROL_MISSING_FIELD` 判失败，不能算作无痕通过。

运行方法：

```sh
node scripts/verify-session-log-request.mjs
node scripts/verify-session-log-request.mjs --negative-control
```

2026-11-09 结果（DSH 0.2.1-rc.5 桌面运行时，隔离 DSH_HOME，当前工作树 preview.11 源码）：

- 正向：`work/session-log-request-20261109134359/`。普通请求 `model=deepseek-flash`、`messages=1`、`dsh_session_log` 7577 字节且含普通探针；无痕请求同 model、`messages=1`、无 `dsh_session_log`、无痕探针在 `messages` 中；两侧 `system`/`tools` 正常；其他请求 0 条；结果 PASS。
- 负向对照：`work/session-log-request-20261109134430/`（隔离 profile 中禁用 `session-log-deepseek` 行）。普通请求没有字段，脚本按 `CONTROL_MISSING_FIELD` 判失败并输出「不得当作通过」，负向对照 PASS。
- 单测：`node --test --test-isolation=none tests/session-log-request.test.mjs`，8/8 通过。

覆盖与未覆盖：

- 覆盖：host 侧真实会话创建与消息入队（`agents.create` + `followup`）、`deepseekLlmApiExtensions.prepare` 的真实字段合并、真实 `POST /v1/messages` HTTP 发送（到本地模拟端）、普通和无痕的同轮对照、普通对照缺失时的失败保护。
- 未覆盖：真实 desktop profile、真实 DeepSeek 服务端（模拟端固定 200 和合成 SSE，不验证接受水位、重试、代理和网络故障）、真实桌面 UI（本验证不经过新建对话页、开关和客户端会话创建）、session title 等辅助模型请求（隔离 profile 关闭了 `session-title-llm`）、附件/工具调用、子 agent 路径（preview.11 已在子 agent 启动和子会话创建入口拒绝，但真实桌面路径未实测）。
- 该脚本依赖本机 DSH 桌面运行时和本机回环 HTTP，不放进 `npm test`；`npm test` 只跑纯判定单元测试。

2026-11-10 复核：隔离脚本拒绝已有或越界运行目录；先执行无痕验证，再创建普通对照。每次拒绝后对 sessions 文件内容哈希进行约 1.5 秒、50 毫秒间隔观察，检查新增、修改和删除；复跑结果无痕阶段 0 → 0，普通子会话仍创建并落盘。`tests/subagent-verification.test.mjs` 覆盖既有文件修改、延迟新增及目录保护。观察无法排除采样间的短暂变化、观察期后的写入或未检查的其他目录。

### M11 隔离子 Agent 服务验证（2026-11-09）

目的：验证 `subagent-guard.js` 和 `persistence.js` 的拒绝发生在子会话写入或 provider 启动之前，并确认普通父会话同一入口不被误伤。

做法：

- 脚本：`node scripts/verify-subagent-guard.mjs`；探针在 `scripts/fixtures/subagent-guard-probe/`。
- 每次新建 `work/subagent-guard-<时间戳>/`，独立 `DSH_HOME`、workspace、模拟模型端；不读取不改动真实 desktop profile。
- 探针在 host 内用真实 `agents.create` 创建普通和无痕两个 Agent，然后调用真实 `ctx.subagents.startActivation`（`dsh-tool-subagent` 的 `subagent` 工具最终使用的同一服务入口）：
  - 无痕父会话：期望被 `subagent-guard` 拒绝；比较调用前后 `$DSH_HOME/sessions` 文件，普通父会话自己的文件（路径含普通 id）不计入新增子会话。
  - 直接调用 `sessionPersistence.create({ parentSession: <无痕 id> })`：期望被 `persistence` 层拒绝，且不产生文件。
  - 普通父会话：同一入口启动子会话；检查 `persistence.stat(childId).header.parentSession` 和新增会话文件。
- 模型端点指向本地模拟 SSE；全部使用合成内容，API key 为本地假值；日志 token 和隔离 home 凭据在运行后打码。

运行方法：

```sh
node scripts/verify-subagent-guard.mjs
```

2026-11-09 结果（连续 3 次 PASS：`work/subagent-guard-20261109140258/`、`work/subagent-guard-20261109140302/`、`work/subagent-guard-20261109140306/`；另一次独立复跑 `work/subagent-guard-20261109140442/` 同样 PASS）：

- 无痕父会话 `startActivation` 抛出「无痕对话暂不支持启动子 agent，避免子会话留下记录」；调用前后 sessions 文件 1 → 1，没有未归属的新增文件。
- 直接带无痕 `parentSession` 的 `persistence.create` 抛出「无痕对话暂不支持创建子会话，避免子会话留下记录」；sessions 文件数不变。
- 普通父会话同一入口返回 childId；`persistence.stat` 可查到，`header.parentSession` 等于普通父会话 id，新增会话文件路径包含子 id。
- 说明：探针里 `sessions.get(childId)` 返回空（probe 服务可见性限制），因此以 `persistence.stat` 的 header 和会话文件作为证据，不把 live 查询当作通过条件。

覆盖与未覆盖：

- 覆盖：真实 host 的 Agent 创建、真实 `subagents.startActivation` 服务入口、两层拒绝、无痕尝试前后会话文件、普通父会话对照。
- 未覆盖：模型调用 `subagent` 工具的参数解析、预设和工具可见性、外部 provider（ACP/SDK/Codex）及其子进程、真实 desktop、附件生命周期。本验证使用 in-process `spawn` provider；「未启动外部进程」只说明该 provider 路径不涉及外部进程，不能推广到所有 provider。

## 每次迭代怎么用

1. 修改前找到受影响的编号；新场景补一行，先写预期，再执行。
2. 运行相关自动测试；涉及共享行为时增加普通会话回归。完成代码修改后运行 `npm test`。
3. 涉及桌面、真实工具或隐私路径时，按对应 M 项进行隔离或桌面验证，记录版本、操作、结果和检查范围。
4. 发现失败则保留复现条件，修复后复测；能稳定自动化的场景补到 `tests/`。不要把模拟测试通过当成真实桌面验收通过。
5. 在本文件更新新证据；详细环境、特殊现象和交接信息继续放在 `技能.md`。
