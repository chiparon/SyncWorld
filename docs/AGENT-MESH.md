# Syncw Agent Mesh 设计（M1 方向）

> 本文回应两个核心诉求：
> **(1)** 兼容不同 agent 软件，插件化，小更新不破坏接口；
> **(2)** agent 之间能互相触发——规划者决定后自动布置任务给执行者，执行完规划者快速拿到结果并审视下一轮。
>
> 参考 Agensh（Microsoft，*Scaling Organizational Intelligence to 1,024 Agents*）。

---

## 0. 先说清楚我读到了什么、没读到什么

这个环境**屏蔽了所有网页正文抓取**（`arxiv.org` / `github.com` / `github.io` / `npmjs.com` 一律返回 *resolves to a non-public IP*）。所以我**没有读到 Agensh 正文**，只能从搜索引擎返回的片段里提取到以下事实：

| 我确证看到的 | 来源 |
|---|---|
| 标题与规模：1,024 个 agent 的"组织智能" | [arXiv 2609.26781](https://arxiv.org/pdf/2609.26781)、[项目页](https://agens-harness.github.io/project/) |
| 中文报道的核心主张：**去掉中心调度器**，让 agent 自组织协作 | [36氪](https://36kr.com/p/4004188524842881)、[C114](https://www.c114.net.cn/industry/129017.html) |
| 论文里 worker 的系统提示词片段：`Hello You are pbench-team1-worker1. ## Where you are You work with 1024 peers. Work is tracked in gitea; you talk on matte…` | arXiv HTML 片段 |
| `- **gitea** - issue #1 is the task` | arXiv PDF 片段 |
| 评测跑在真实大仓上（表格中出现 FFmpeg，列含 Task / Commit / Files / Lines of code / Code size） | arXiv PDF 片段 |
| 存在一个"1024 个 agent 如何协作"的回放页 | [agens-harness.github.io/project/replay.html](https://agens-harness.github.io/project/replay.html) |
| 同期相关工作：《How Self-Organizing LLM Agents Outperform Designed Structures》 | [arXiv 2603.28990](https://huggingface.co/buckets/huggingchat/papers-content/tree/2603/2603.28990.md) |

**由此推出的（是我的推断，不是论文原话）**：Agensh 的协调基座是**现成的协作基础设施**——Gitea 承担工作跟踪（**issue 就是任务**），Mattermost 承担对话——而不是一个自研调度器。agent 是拥有身份的平级节点（`team1-worker1`）。

> ⚠️ **请你复核这一条。** 本文后面所有对 Agensh 的引用都建立在"Gitea + Mattermost 即基座、无中心调度"这个推断上。如果论文实际机制不同（比如有隐式的角色协商层），第 2 节的核心论证需要重写。你能把正文贴给我最好。

---

## 1. 架构主张

Agensh 最值钱的一课不是"1024 个 agent"，而是**选对了协调介质**。

我 M0 的驱动介质是 agent CLI 的 flag 和 stdout 格式。那是整个技术栈里**最容易变的东西**：Codex 改个 `--json` 结构、Claude Code 换一版 stream-json，流水线就静默出错——这正是你诉求 1 担心的。

Agensh 把协调放在 **git + issue + chat** 上。这三个东西：

- **稳定**。git 的对象模型、issue 的状态机、chat 的消息语义，生命周期以**年**计。而 agent CLI 的 flag 以**周**计。
- **agent 天生会用**。Claude Code 和 Codex 都被训练过读写 git、跑 `gh`/`glab`/`tea`、阅读 issue。你不需要教它们新协议。
- **天然可审计、可重放**。issue 历史、commit、PR review 本身就是编年史。

于是架构主张是：

> **把稳定的协议放在中心，把易变的 CLI 赶到边缘。**
> 协调走 git/issue/chat；agent 软件只作为"可替换的执行末端"接在边缘上。

这一条同时解决你的两个诉求：诉求 1 靠**边缘的驱动层 + 探针**兜住；诉求 2 靠**中心的 issue 状态机**实现——"布置任务"就是开一个 issue，"拿到结果"就是这个 issue 被 close / PR 被 merge。

### 1.1 基座与拓扑必须分离

这里有个容易混掉的地方，我要单独点出来：

- **Agensh 的基座是去中心的**（1024 个平级 peer，无调度器）。
- **你要的拓扑是分层的**（规划者决定、执行者执行）。

**这两者不矛盾，但必须分开。** 基座不决定拓扑：

| | 是什么 | 谁决定 |
|---|---|---|
| **基座（substrate）** | 任务放哪、状态怎么流转、消息怎么送达 | 协议。**去中心、平级、无调度器** |
| **拓扑（topology）** | 谁扮演规划者、谁扮演执行者、谁能派发给谁 | **策略**。可以分层，也可以涌现 |

所以 Syncw 不去实现一个"主循环调度器"，而是提供一张**共享工作台**：任何人（人或 agent）都能开 issue、认领 issue、开 PR、评审 PR。你想要的"规划者"只是**一个持续认领 `role:planner` 标签 issue 的 agent**。

这和我 M0 那句"编排是数据，执行是引擎"是同一条思路的延伸：**基座是协议，拓扑是策略。**

---

## 2. 诉求 1：驱动层（Driver Layer）

### 2.1 四层反腐蚀

```
┌─────────────────────────────────────────────────────────┐
│ 4. 变速箱：优先结构化输出，PTY 只作最后手段              │
├─────────────────────────────────────────────────────────┤
│ 3. 一致性探针：指纹漂移 → canary 任务 → fail closed      │  ← 解药在这一层
├─────────────────────────────────────────────────────────┤
│ 2. 归一化事件流：各家 raw output → 一套内部词汇          │
├─────────────────────────────────────────────────────────┤
│ 1. 能力契约：用 Syncw 的词汇声明"我需要什么样的执行者"   │
└─────────────────────────────────────────────────────────┘
```

### 2.2 第 1 层：能力契约

工作流里**不写 flag**，写能力需求：

```yaml
executor:
  driver: codex            # 具体软件，可替换
  require:
    - non_interactive      # 能非交互跑
    - structured_output    # 能吐结构化事件
    - session_resume       # 能恢复会话
  prefer: cost             # 或 latency / quality
```

驱动声明自己是**数据**，不是假设：

```ts
interface DriverCapabilities {
  nonInteractive:    boolean;
  structuredOutput:  'stream-json' | 'json' | 'text-only';
  sessionResume:     boolean;
  steerable:         boolean;          // 运行中能否插入消息
  mcp:               'client' | 'server' | 'both' | 'none';
  sandboxModes:      Array<'read-only' | 'workspace-write' | 'full'>;
  approvalControl:   boolean;          // 能否关掉/接管人工审批
  modelSelection:    'flag' | 'config' | 'env';
  usageReporting:    boolean;          // ← 很多 agent 不报用量，必须能诚实声明
  fileAttribution:   'git' | 'diff' | 'none';
  costModel:         'reported' | 'estimated' | 'subscription';
}
```

`require: [structured_output]` 会在**绑定阶段**就淘汰掉只能 PTY 驱动的驱动，而不是跑到一半发现解析不了。

### 2.3 第 2 层：归一化事件流

没有这一层，诉求 1 不可能实现——每个工作流都会长在某个 CLI 的输出格式上。

```ts
type AgentEvent =
  | { kind: 'session.start'; sessionId: string; driver: string; model?: string }
  | { kind: 'message';      role: 'assistant' | 'user'; text: string }
  | { kind: 'reasoning';    text: string }
  | { kind: 'tool_call';    id: string; name: string; input: unknown }
  | { kind: 'tool_result';  id: string; ok: boolean; output: string }
  | { kind: 'file_edit';    path: string; added?: number; removed?: number }
  | { kind: 'command';      argv: string[]; exitCode: number; stdoutTail: string }
  | { kind: 'usage';        in: number; out: number; costUsd?: number }
  | { kind: 'error';        message: string; retryable: boolean }
  | { kind: 'session.end';  reason: 'done'|'cancelled'|'crashed'|'timeout'; code?: number };
```

**规则**：驱动解析失败时**必须**产出 `{ kind:'error', retryable:false }` 并附带原始行，**绝不静默吞掉**。一行解析不了就当作协议违规上报——这是探针能工作的前提。

### 2.4 第 3 层：指纹 + 漂移检测 + 一致性探针 ← 解药

这是诉求 1 唯一的真正答案。

```
① 首次使用
   probe() → { binaryPath, versionString, capabilities,
               helpHash, schemaHashes[] }
   写入 .syncw/drivers.lock（提交进仓库）

② 每次运行前的廉价复检
   --version 字符串 + --help 输出哈希
   未变 → 信任 lock，零额外开销
   变了 ↓

③ 完整一致性探针（在临时 worktree 里跑一小组固定 canary 任务）
   a. 最小成功任务：改一个文件、退 0
   b. 一次工具调用：触发一个已知工具，校验事件形状
   c. 一次失败退出：故意让命令失败，校验退出码语义
   d. 结构化输出：校验能不能解析、必需字段还在不在
   e. 会话恢复：起会话→中断→resume→校验上下文还在
   校验：事件顺序、字段存在性、退出码语义、usage 是否还在报

④ 判定
   通过 → 更新 lock，把新指纹写进编年史，运行继续
   失败 → fail closed，输出：
          · 哪个能力坏了（capability: structuredOutput）
          · 期望什么 vs 实际收到什么（原始输出附上）
          · 上一个已知可用版本
          · 是否可用降级驱动继续（如 stream-json → text-only）
```

**为什么这比"写健壮的解析器"强**：解析器再健壮也只能处理你预见到的变化。探针把"未预见的变化"转化成"启动时的一次明确失败"。你要的不是"Codex 更新后还能跑"，而是**"Codex 更新后如果跑不了，我立刻知道、且知道坏在哪"**。前者不可能长期做到，后者可以。

### 2.5 第 4 层：TUI 是陷阱

你说的是 "claudecode **tui**"。我必须直说：**用 PTY 驱动 TUI 再解析 ANSI 流，是这套设计里最脆弱的一环**——重绘、进度条、光标移动、窗口尺寸变化都会污染解析，而且这些恰恰是小版本更新最爱动的地方。

两家都提供 headless 模式（Claude Code 的 `-p/--print` 搭配 stream-json NDJSON 输出；Codex 的 `exec`）。社区已经有人在做同样的事：见 [claude-cli-agent-protocol](https://www.learn-skills.dev/en/skills/bohdan-shulha/skills/claude-cli-agent-protocol)、[claude-crew](https://dev.to/gentic_news/build-a-persistent-multi-surface-claude-code-agent-inside-claude-crew-2mkf)。

> **具体 flag 名我不替你写死**——我抓不到官方文档，而且它们本来就会变。这正是探针层存在的意义：**让 flag 名成为可探测、可降级的数据，而不是散落在代码里的字面量。**

PTY 驱动作为 `structuredOutput: 'text-only'` 的降级驱动保留，并在能力表里明确标注 `fragile: true`。

---

## 3. 诉求 2：派发协议

### 3.1 Round loop，不是 DAG

我 M0 的 DAG 调度器在这里是**错的形状**。你要的是循环：

```
Round n:
  ① planner.produce()   -> { intent: dispatch | revise | done, task?: TaskPackage }
  ② if dispatch:
       issue  = open_issue(task)              # 落到 Gitea，任务即 issue
       branch = worktree(issue)               # 隔离工作区
       run    = executor.execute(issue, branch)
       result = collect(run)                  # diff / tests / artifacts
       close_issue(issue, result)
  ③ digest = digest(result)                  # 压到规划者能消化的量
  ④ planner.observe(digest)                  # 喂回，进入 Round n+1
```

### 3.2 派发信令怎么表达

| 方案 | 评价 |
|---|---|
| **git issue（Gitea/GitHub/GitLab）** | ✅ **首选基座**。持久、可审计、跨重启、人类可读可介入，agent 天生会用 |
| **MCP 工具**（给规划者 `dispatch_task`） | ✅ **首选交互**。规划者自然调用，无需 prompt 诡计 |
| 规划者写自定义任务文件到目录 | ⚠️ 能用，但等于自研一个更差的 issue tracker |
| 解析规划者的自然语言输出 | ❌ 脆弱，别做 |
| 每轮重新 `-p` 一次性调用规划者 | ⚠️ 简单，但每轮丢上下文，长项目又贵又有损 |

**推荐组合**：MCP 工具作为规划者的**交互面**，git issue 作为**持久底座**。`dispatch_task` 内部就是"开 issue + 等 issue close"，立即返回 task id，配 `await_task(taskId, timeoutMs)`；MCP 的 progress notification 用来流式报进度。这样"执行完规划者快速拿到结果"就是一次普通的工具返回。

**谁都能派发。** 因为基座是 issue，所以人、脚本、其他 agent 都能开 issue。规划者不是特权节点，它只是**当前认领了 planning 角色的那个 agent**——这正是 Agensh 的平级性，与你想要的分层拓扑并不冲突（§1.1）。

### 3.3 `TaskPackage`：交接的上下文经济学

这是整个设计里最难也最值钱的地方。规划者上下文又大又丰富，执行者上下文必须有界。两个失败模式：

- **给太多**：把规划者的 transcript 灌给执行者 → 执行者去模仿规划者的**推理过程**而不是执行**任务**，又贵又偏。
- **给太少**：只给一句话 → 执行者不知道当初为什么这么定，会重开已经否决过的方案。

```yaml
task:
  id: t-001
  goal: "<一句话，说结果不说方法>"
  acceptance:                     # 可检查的验收信号，不是形容词
    - "npm test 通过"
    - "不新增运行时依赖"
  constraints:
    - "不要碰 migrations/"
    - "公开 API 保持稳定"
  context_refs:                   # ← 关键：引用，不是内容
    - { kind: file,     path: docs/DESIGN.md, selector: "§3" }
    - { kind: artifact, id: a-17 }
    - { kind: issue,    id: "#482" }
  non_goals:                      # 显式排除，防止执行者扩张范围
    - "不重构现有 rate limiter"
  workspace: { repo: ., branch: syncw/t-001, base: main }
  budget: { max_usd: 2, max_minutes: 20 }
  return_contract:
    diff: true
    tests: { run: "npm test", must_pass: true }
    digest: { max_tokens: 800 }
    artifacts: ["open_questions"]
```

**`context_refs` 是我最满意的一处设计。** 执行者通过工具**按需**拉取（MCP `read_artifact`，或直接读文件、读 issue），于是：

- 规划者可以写"参见 DESIGN.md §3"而**不烧上下文**；
- Syncw **不需要猜**该内联什么（猜错就是上面第一种失败模式）；
- 引用本身是**可审计**的——你能看到执行者到底读了什么。

这三条加起来，`context_refs` 同时解决了信息丢失、成本、和可解释性。

### 3.4 `RunResult`：摘要 + 句柄

执行者产出十万 token 的 transcript，规划者只需要八百 token。

**规则：永不内联 transcript，永远给句柄。**

```yaml
result:
  task_id: t-001
  status: ok | failed | partial | timed_out | cancelled
  exit_reason: "<原始退出原因>"
  diff:      { stat: "3 files, +120/-40", ref: "artifact://a-18" }
  tests:     { command: "npm test", exit_code: 0, summary: "42 passed" }
  files_touched: ["src/limiter.ts", "src/limiter.test.ts"]
  decisions:     ["选择了令牌桶而非漏桶，因为 ..."]   # 从结构化输出提取
  open_questions: ["多租户配额从哪读？"]              # 要求执行者显式产出
  usage:     { in: 120000, out: 8000, cost_usd: 0.42, wall_seconds: 340 }
  artifacts: ["a-18", "a-19"]
  transcript_ref: "artifact://a-20"
```

两条纪律：

- **摘要由结构生成，不额外调一个模型去总结。** 多一个模型就多一个失败模式，而且它会撒谎。
- **`open_questions` 必须由执行者显式产出**，不能由我们推断。这是规划者下一轮的输入，猜错等于把回路带偏。

---

## 4. 工作区隔离与 exactly-once

### 4.1 每个任务一个 git worktree

```
git worktree add ../wt-t-001 -b syncw/t-001
```

执行者在里面干活，结果以**分支**回来，规划者审 diff 再决定合并或打回。

| 方案 | 评价 |
|---|---|
| 共享工作区串行执行 | ❌ 规划者未提交的改动会和执行者打架 |
| **每任务一个 worktree** | ✅ **默认**。天然得到 diff 产物、回滚点、PR 语义 |
| 每任务一个容器/VM | ✅ 执行者开 full-auto / 免审批权限时**必须**上 |

### 4.2 exactly-once 派发

Syncw 在执行者跑到一半时崩了，重启后要不要重派？执行者可能已经 push 了 commit。

需要三件东西：

1. **issue 状态机**：`todo → in_progress → review → done`，外加 `lease` 字段（谁在跑、什么时候开始的）。
2. **工作区租约**：`in_progress` 且租约未过期 → 不重派；租约过期 → 检查该分支上**是否已有新 commit**，有则转 `review`，无则回收重派。
3. **幂等键**：`task_id` 就是幂等键，重复派发必须先通过租约检查。

这就是 durable execution 问题——也正是我一开始建议**把长流程交给 Temporal/Restate 兜底**的原因。issue 状态机是"看起来够用"的版本；一旦回路要跑几小时、要跨机器，就该换真的工作流引擎。

---

## 5. 上下文经济学：规划者膨胀

**这是没人提前想到、但跑到第 10 轮必然爆的问题。**

阻塞式派发跑 10 轮后，规划者身上背着：10 份摘要 + 自己 10 轮的完整推理 + 它读过的所有文件。你会以为"上下文窗口够大就行"，但成本和判断质量都会崩。

需要**为规划者定义显式的上下文分层**：

| 层 | 内容 | 生命周期 |
|---|---|---|
| **常驻（pinned）** | 目标、硬约束、当前计划、验收标准 | 全程 |
| **滚动（rolling）** | 最近 K 轮摘要 | 滑动窗口 |
| **归档（archived）** | 更早的轮次 → **只留 artifact / issue 句柄** | 按需拉取 |
| **丢弃（dropped）** | 已否决的方案、已完成的工具输出 | 立即 |

这恰好是 "Synchronized World" 真正兑现价值的地方：

> **共享状态是 artifact store + issue tracker，每个 agent 的上下文只是它上面的一个视图（view），不是一份拷贝。**

一旦你这么建模，"规划者膨胀"就从一个玄学问题变成一个**可配置的保留策略**——和世界态的 merge 策略是同一类东西。

---

## 6. M0 的遗产清单

诚实盘点。M0 是照着"agent = prompt + 契约"建的，执行基座换了，有些东西直接死掉。

### 存活，且直接搬过去

| M0 | 在新架构里 |
|---|---|
| [binding.ts](../src/runtime/binding.ts) 绑定策略引擎 | 泛化为"选执行者"（driver × model × sandbox × 预算） |
| [requirements.ts](../src/runtime/requirements.ts) 约束语言 + **安全/资源分离** | 原样保留。`not_family_of` 变成 `not_same_driver_as`，语义完全一致 |
| [trace.ts](../src/runtime/trace.ts) 编年史 | 保留，且更重要——agent 运行更慢、更不确定、更贵 |
| `syncw bind` 干跑预览 | 保留，改成预览"这一轮会派给谁" |
| 世界态 + 合并语义 | 主体变成工作区 + artifact store + issue tracker |

### 死掉

| M0 | 为什么 |
|---|---|
| **内容寻址缓存** | **不成立。** agent 运行会改文件系统，`run(agent, task, repo)` 不是纯函数，是状态转移 |
| DAG 调度器 | 形状不对，要换成 round loop 状态机 |
| `agent = prompt + out 契约` | 抽象要重写为 `AgentDriver` 会话 |
| `providers/openai-compat.ts` | 降级为"直接调模型"的一种 driver，不再是主线 |

关于缓存我要多说一句，因为它是我 M0 的旗舰能力之一：你**可以**按 `(repo_tree_hash, task_hash, driver_fingerprint)` 做记忆化，但 repo 每轮都在变，命中率趋近于零；而且即使命中了输出，**副作用也没重放**。所以正确的心智模型是：

> 它从「记忆化」退化成「**检查点**」。而"能把整个世界（repo + transcript + artifacts + issue 状态）倒回状态 X"在这个场景下其实**比记忆化更有价值**——只是那是另一个东西，且必须建立在 git + artifact store 之上。

---

## 7. 路线图

| | 内容 | 为什么这个顺序 |
|---|---|---|
| **M1a** | 驱动契约 + 一个真驱动（`codex exec` 或 Claude Code print）+ 归一化事件流 | 先把最不确定的东西跑通 |
| **M1b** | 一致性探针 + `drivers.lock` + fail-closed | 诉求 1 的核心价值在这 |
| **M1c** | 第二个驱动，验证"换软件不改工作流" | 只有一个驱动时，抽象是假的 |
| **M2a** | 本地 issue 后端（先用 git 分支 + 文件，后接 Gitea）+ worktree 隔离 | 基座先立住 |
| **M2b** | TaskPackage / context_refs / RunResult digest | 派发协议的实质 |
| **M2c** | round loop：planner → dispatch → digest → observe | 诉求 2 闭环 |
| **M3** | 规划者上下文分层与保留策略 | 跑到 10 轮之前必须做 |
| **M4** | 多执行者并发 + 租约 + exactly-once | 才需要真工作流引擎 |
| **M5** | 涌现拓扑：不再指定规划者，让角色从 `role:*` 标签竞争产生 | Agensh 那一端 |

**M1 建议只做一条最窄的竖切**：一个规划者、一个执行者、一个 issue、一个 worktree、一个探针。把这个竖切跑通，再谈 1024。

---

## 8. 需要你拍板的开放问题

1. **Agensh 的推断对不对？**（§0）如果论文实际不是"Gitea + Mattermost 即基座"，第 2 节要重写。
2. **基座选哪套？** Gitea / GitHub / GitLab 自建 vs SaaS。Agensh 用 Gitea（可自建、轻）；你在国内网络下 GitHub 可能不稳，这会影响选型。
3. **规划者会话是长驻还是每轮重建？** 长驻质量高但会膨胀（§5）；每轮重建便宜但有损。我倾向长驻 + 显式保留策略。
4. **派发是阻塞还是异步？** 我建议先做阻塞（90% 场景、实现简单），异步留给长任务。
5. **执行者能不能开 full-auto？** 这决定要不要上容器隔离，是成本上的大分叉。
