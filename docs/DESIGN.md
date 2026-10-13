# Syncw 设计文档（M0）

> **状态：M0 快照。** 本文描述的实现真实存在、可运行、有测试覆盖（[`npm run verify`](../package.json)）。
>
> 但**目标架构已经演进**：M0 把 "agent" 建模为「prompt + 输出契约」，而目标是把 "agent" 建模为**已有的 agent 软件**（Codex CLI、Claude Code）的长期会话。
> 新方向见 **[AGENT-MESH.md](AGENT-MESH.md)**，其中也列出了本文哪些部分在迁移中会失效（§6 遗产清单，特别是内容寻址缓存）。
>
> 阅读顺序建议：先本文 §3.2（安全/资源约束分离）与 §6（级联效应实测），这两条在演进后依然成立。

> **Syncw = Synchronized World。**
> 名字取自 Dune 的 Omnius——但 Omnius 的本质从来不是"一个超级 AI"，
> 而是**一份被所有子代理共享的世界态，加一套让它们保持同步的协议**。
> 这份文档的每一节都在把这句话翻译成工程结构。

---

## 0. 一句话论点

> **编排是数据（DSL），执行是引擎（Runtime），绑定是策略（Binding Policy）。**

Agent 只描述**做什么**（角色、指令、IO 契约），**不含模型**；谁来做，由运行时根据策略在模型空间里查询决定。

这条论点有一个可证伪的验收标准：

> **任何节点的 provider + model 都能换掉，而不用改 agent 的 prompt，也不用改工作流的拓扑。做不到，就是抽象漏了。**

M0 的代码全部围绕这一条展开，其余功能都是它的推论。

---

## 1. 三个正交注册表

| 注册表 | 目录 | 内容 | 变更频率 |
|---|---|---|---|
| **行为** | `agents/` | role、instructions、工具授权、`in`/`out` 契约 | 低 |
| **接入** | `providers/` | 凭证、endpoint、限流、重试 | 中 |
| **能力** | `models/` | 上下文窗口、capability、$/Mtok、p50 延迟、quality 先验 | **高**（每周都在变） |
| **编排** | `workflows/` | 拓扑 + 绑定策略 + 世界态 schema + 失败语义 | 中 |
| **证据** | `runs/` | 编年史（完整 trace），可重放、可 diff | 每次运行 |

三者的交叉引用为零：`AgentSpec` 里没有 `model` 字段，`ProviderConfig` 里没有模型列表，`ModelProfile` 里没有 prompt。

`models/` 是最被低估的一层。**模型的能力画像是会过期的**——价格、上下文、是否支持 JSON Schema、tool-call 风格，几个月就变一轮。把它做成独立可编辑的注册表，而不是散落在各处的 `if model == "claude"`，是让整个系统可维护的前提。

---

## 2. 世界态：把 "Synchronized" 变成技术主张

现有框架几乎都只在**边上传递消息**，没有共享状态。这恰好是多代理系统的崩溃点：并发写互相覆盖、上下文每次跳转被有损摘要、无法回滚到干净点。

Syncw 把 **World State 做成一等公民**——带类型的黑板，每个字段声明**合并语义**和**属主**：

```yaml
world:
  plan:
    type: json
    merge: replace
    owner: plan          # 只有 plan 节点能写；别人写就报错

  findings:
    type: json
    merge: append        # 三个并发 researcher 各追加一条，安全

  verdict:
    type: json
    merge: replace
    owner: judge
```

六种合并策略：`replace` / `append` / `last_write_wins` / `first_write_wins` / `sum` / `max`。

两个被刻意实现的细节：

- **`owner:` 是强制执行的，不是文档。** 越权写入抛 `WorldOwnershipError`。并发代理静默污染状态是这类系统最难查的 bug。
- **`replace` 在检测到第二个写入者时会记录 conflict。** 它的语义是"我认为只有我在写"；如果这个假设被打破，你应该知道。想表达"允许覆盖"就用 `last_write_wins`。

一旦有了它，**并行 fan-out 的正确性、断点续跑、局部重算、非线性打回重做**全都免费得到。

---

## 3. 绑定策略引擎（核心）

这是整个项目里别处没有的东西，也是 `src/runtime/binding.ts` 的全部内容。

**输入**：一个对模型空间的*查询* + 当前世界态。
**输出**：一个具体的模型，加上一份完整的、可审计的决策说明。

### 3.1 解析顺序

```
1. pin        绝对人工覆盖。刻意绕过 require:，并在 trace 里注明——
              一个"默默遵守约束"的 pin 是你没法用来 debug 的 pin。
2. by_index   异构 fan-out，第 i 个 item 交给不同厂商。同样显式、同样绕过约束。
3. require / prefer   常规路径：先用硬约束过滤，再排序。
4. fallback   按顺序尝试的 glob 链。见 3.2，这里有一条关键的设计线。
```

### 3.2 安全约束 vs 资源约束（本设计最重要的一条线）

`fallback:` 到底该不该绕过硬约束？两边都说得通，但放任它绕过会出人命：

```yaml
require:
  - not_family_of:$.nodes.research.actual_families   # 评委不能和生产者同族
fallback: [deepseek/*, google/*]
```

如果 fallback 可以绕过硬约束，那么"同族自评"这条防线会在系统承压时**静默失效**——而这恰恰是最需要它的时候。

所以约束被分成两类，由引擎强制：

| 类别 | 成员 | 能否被 `fallback` 降级 |
|---|---|---|
| **SAFETY 安全约束** | `not_family_of` / `not_same_as` / `provider:` / `family:` | **永不** |
| **RESOURCE 资源约束** | capability 存在性、`ctx` / `cost` / `quality` / `latency` 数值比较 | 可以 |

一句话：**安全约束不可降级，资源约束可降级。** 上下文窗口小一点是更差的结果，不是错误的结果；同族自评是错误的结果。

这不是约定，是 `src/runtime/requirements.ts` 里 `RequirementKind` 的类型系统保证。

### 3.3 可解释性是硬需求

引擎会评估**注册表里的每一个模型**并记录落选原因，不只是选出赢家：

```
judge
  → ollama/qwen3-235b [item 0] via policy
      · declared `fallback:` [deepseek/*, google/*, openai/*] could not be honoured
        without violating a SAFETY constraint, so the general policy was re-resolved
      · selected by policy: prefer=quality
      · constraints: json_schema AND not_family_of:$.nodes.research.actual_families
      · 2/11 models satisfied the constraints
      · beat ollama/llama4-maverick on quality score (0.740 vs 0.720)
```

**你无法审计的绑定决策，你不敢让它上生产。** 这份输出由 `syncw explain <runId>` 直接读取 trace 生成。

注意上面这段真实输出：fallback 链因为会违反安全约束而**无法被满足**时，引擎改走通用策略（仍然强制安全约束），并且**如实说明它没有遵守你写的 fallback 链**。静默替换比报错危险得多。

### 3.4 `$.nodes.<id>.actual_model` ——让跨模型约束可声明

`not_family_of: $.nodes.implement.actual_model` 里的目标，是**上一个节点实际跑在哪个模型上**，而不是你在文件里写了什么。

这一点至关重要：implement 节点的模型是运行时按 `prefer: cost` + `quality>=0.80` 算出来的，甚至可能在失败后被 escalate 换成另一个。约束依然成立。

同理 `actual_families`（复数）在 fan-out 场景下是**实际用到的所有族**的列表。M0 开发过程中这里暴露过一个真实 bug：当 fan-out 恰好坍缩到单一模型时，`actual_families` 曾经不存在，导致下游 `not_family_of` 引用失败并被误报成"没有模型满足约束"。修复方式是**无论异构与否都恒定暴露数组**——异构性是运行时的属性，不是集合基数的属性。

---

## 4. DSL 参考

```yaml
name: feature-dev
input:
  goal: { type: string, required: true, default: "..." }
budget: { max_usd: 5.00 }

world: { ... }                          # 见 §2

nodes:
  - id: plan
    agent: planner                      # 行为，与模型无关
    bind:                               # 查询，不是赋值
      require: [json_schema, ctx>=200k]
      prefer: quality
      fallback: [deepseek/*, google/*]
    in:  { goal: $.input.goal }
    out: [plan]                         # world 字段 <- 契约字段（同名可简写）

  - id: research
    agent: researcher
    needs: [plan]
    for_each: $.world.plan.steps        # fan-out；item 在节点内以 `$` 引用
    join: all                           # all | any | quorum(n) | best_of(n)
    bind:
      by_index:                         # 第 i 个 item 绑不同厂商 —— 异构并行
        - anthropic/claude-sonnet-4-5
        - openai/gpt-5
        - google/gemini-2-5-pro
    budget: { max_parallel: 3, max_usd: 1.00 }
    in:  { question: $.item.title }
    out: [findings]

  - id: gate
    kind: human_gate
    when: $.world.verdict.confidence < 0.75    # 条件为假则跳过，零成本

  - id: implement
    agent: implementer
    needs: [judge, gate]
    retries: 1
    bind:
      require: [json_schema, ctx>=128k, quality>=0.80]
      prefer: cost
      escalate_if: { retries: 1, to: quality }
```

**引用表达式**：`$.input.*` / `$.world.*` / `$.nodes.<id>.actual_model|actual_families|cost_usd|status|output` / `$`（当前 item）。非 `$` 开头一律视为字面量。

**守卫表达式**：只支持单次比较（`==` `!=` `<` `<=` `>` `>=`）或裸引用真值判断。**没有 `eval`——工作流文件永远是数据，不是代码。**

`needs` 省略时默认依赖**声明顺序里的上一个节点**，所以线性流程读起来是自上而下的。

---

## 5. 可重放性

三件套：

1. **编年史**：每次运行写 `runs/<runId>/trace.jsonl`，逐事件记录绑定决策、候选、请求、响应、世界写入、冲突、升级。`meta.json` 记录逐节点成本/token/延迟/尝试次数，`world.json` 是最终世界态快照。
2. **内容寻址缓存**：键 = `sha256(model | params | messages | 契约)`，存在 `.syncw/cache/`。
3. **`--swap` + `diff`**：换掉任一节点的模型重跑，未被改动的节点由缓存逐字节返回。

缓存是让 diff **诚实**的前提。没有它，"比较两个绑定"看到的是噪声；有了它，diff 里剩下的就是你改的那一件事。

---

## 6. 实测：级联效应

这不是假设，是 `npm run demo` 的实际输出（`scripts/demo.ts` 全自动，无需 API key，末尾带 7 项自动断言）。

**基线**：六个节点，工作流里**没有任何一处写死模型**。

```
plan       anthropic/claude-opus-4-1
research   anthropic/claude-sonnet-4-5, openai/gpt-5, google/gemini-2-5-pro   ← 异构并行
judge      deepseek/deepseek-v3-2        ← 被约束推出三家厂商的血统之外
implement  deepseek/deepseek-v3-2        ← quality>=0.80 地板 + prefer:cost
verify     anthropic/claude-opus-4-1     ← 与 implement 不同族，对抗性复核
cost $0.0500
```

**改动一行**：`--swap research=openai/gpt-5`（三个 research item 全绑 gpt-5）。

```
             基线                       重放后                          Δcost
plan         claude-opus-4-1       →   claude-opus-4-1（全缓存）       $0.0229 → $0
research     sonnet+gpt+gemini     →   gpt-5（1/4 缓存）               $0.0121 → $0.0060
judge        deepseek-v3-2         →   claude-opus-4-1  ← 你没改！      $0.0003 → $0.0154   (59×)
implement    deepseek-v3-2         →   deepseek-v3-2                   $0.0002 → $0.0002
verify       claude-opus-4-1       →   claude-opus-4-1                 $0.0146 → $0.0130
```

**发生了什么**：research 的 `actual_families` 从 `{claude, gpt, gemini}` 变成 `{gpt}`，于是 judge 的 `not_family_of` 候选池缩小——Claude 成了质量最高的可用选项。judge 的置信度从 0.84 掉到 0.59，**触发了原本被跳过的人工闸门**，最终结论从 `passed: false` 翻成 `passed: true`。

### 6.1 缓存让"总成本"变成一句谎话

上面有个陷阱，值得单独说：

```
朴素总账        $0.0500 → $0.0345   (-31%)   ← 看起来省钱了
同口径（B 中真正发起调用的 3 个节点）  $0.0150 → $0.0286   (+91%)
```

重放里被缓存命中的节点记 **$0**，所以两次运行的总成本**本来就不可比**。如果只看最后一行，你会得出"这次改动省了 31%"的结论——而事实是**干活的那部分贵了 91%**。

引擎因此在 diff 里强制打印同口径对比，并在 [demo.ts](../scripts/demo.ts) 里加了"缓存节点必须恰好花费 $0"的断言。这是实现过程中由测试抓出来的真实 bug：最初缓存命中也会按 usage 计费，导致每次重放都虚报开销。

> 这就是整个项目的论点：**在跨模型流水线里，你无法逐节点地推理成本和行为。** 一个局部变更会重路由下游、改写结论、并且让总账给出相反的方向。编年史是唯一会告诉你真相的东西。

---

## 7. 失败语义

失败恢复是**重新绑定**，不是应用层 try/catch。顺序固定：

```
1. retries: n        排除失败模型，按原策略重绑，共 n 次
2. fallback: [globs] 走声明的备选链（只放松资源约束，安全约束照旧）
3. escalate_if       切换 prefer 重新绑定（如 cost → quality）
4. 都没有 → 抛出，run 标记 failed
```

实测（注入 `deepseek/*` 全部失败）：

```
judge      ↻  deepseek/deepseek-v3-2 failed; retrying via re-bind (0 retries left)
judge      ⇩  deepseek/deepseek-r1 failed; walking fallback [deepseek/*, google/*, openai/*]
judge      ✔  ollama/qwen3-235b   3 attempts
implement  ↻  deepseek/deepseek-v3-2 failed; retrying via re-bind
implement  ✔  openai/gpt-5-mini   2 attempts
verify     ✔  anthropic/claude-opus-4-1
```

judge 的 fallback 链因安全约束落空（`google/*` = gemini，正是生产者血统），引擎如实记录这一点并改走通用策略，仍然强制 `not_family_of`，最终落在 qwen。**降级了资源，守住了安全。**

fan-out 的 join 策略决定部分失败如何处理：`all` 全成功才通过、`any` 至少一个、`quorum(n)` 达到 n 个、`best_of(n)` 按自报置信度取前 n（写出时只提交前 n 个）。

---

## 8. 与现有工具的位置关系

| | 编排 | 绑定模型 | 共享状态 | 可重放/diff | 自适应选型 |
|---|---|---|---|---|---|
| LangGraph | 强（代码优先） | 弱，散在各 node | 无 | 弱 | 无 |
| CrewAI / AutoGen | 中 | 中 | 无 | 弱 | 无 |
| Dify / n8n / Langflow | 强（可视化） | 每节点零散 | 弱 | 无 | 无 |
| LiteLLM / OpenRouter | — | **强** | — | — | 部分 |
| **Syncw 目标位** | 强（声明式） | **强（策略引擎）** | **强（有合并语义）** | **强** | **强** |

**不造协议层**（这是刻意的取舍）：工具用 MCP，跨进程 agent 用 A2A（已捐给 Linux Foundation），模型接入用 OpenAI 兼容格式。

`providers/anthropic.yaml` 是这个取舍的具体体现：Anthropic 原生 API 不是 OpenAI 形状，而我们**没有**为它写第二个适配器，而是让你用 LiteLLM 之类的网关前置并指向它。Syncw 的价值在选型和编排，不在协议翻译。

---

## 9. 路线图

| | 内容 | 状态 |
|---|---|---|
| **M0** | 引擎骨架、世界态、绑定策略、trace、缓存、`replay`+`diff` | ✅ 本仓库 |
| **M1** | `best_of(n, by=judge)` 真调评委；契约 JSON Schema 严格校验；`join` 的 partial 语义 | |
| **M2** | Shapes 组合子库：`chain` / `map` / `reduce` / `vote` / `debate` / `critic_loop` / `router` / `race` / `saga` | |
| **M3** | **评测闭环 → 自适应绑定**：跑 N 个模型打分，回写 `models.yaml` 的 `quality`；影子模式 + 灰度晋升 | ← 真正的 payoff |
| **M4** | 可观测 UI、人在环交互、预算面板。UI 是 DSL 的投影，不是真相源 | |
| **M5** | 元代理 Omnius：读编年史，提议并热改工作流 | |

**M3 是灵魂。** 现在 `models.yaml` 里的 `quality` 是静态先验——那只是一个占位符。一旦用本项目的评测历史去覆写它，系统就会**从自己的运行记录里学会哪个节点该绑哪个模型**。到那时，"Synchronized World" 就从比喻变成了涌现出来的性质，而且这是目前没人做到的。

---

## 10. 已知限制（M0 如实说明）

- **mock provider 不是语言模型。** 它是确定性合成器，按模型族改变行文风格（未知族也会派生出独立声线，否则跨模型 diff 会退化成"看起来一样"），好让跨模型 diff 有意义。所有机制（绑定、缓存、重放、diff、升级）在接真实 provider 后行为完全一致，但**输出内容本身没有语义价值**。
- **测试覆盖的是机制，不是模型质量。** `npm test` 的 75 个用例跑在合成器上，验证的是引擎的决策与记账逻辑；接真实 provider 后仍需用 M3 的评测闭环来验证业务效果。
- **`models/models.yaml` 里的价格和能力是示意值。** 请以厂商定价页为准。文件开头已注明。
- **`temperature` 默认 0**，为了重放可复现。需要多样性的场景（debate）应在工作流里显式覆盖。
- **`when` 守卫只支持单次比较**，没有布尔组合。需要复杂条件时用中间节点表达。
- **fan-out 的 item 数在运行前未知**，所以 `syncw bind` 用 `by_index` 长度做名义宽度做预测；真实宽度由生产者节点决定。
- **人在环的拒绝语义是中止整个 run**，没有实现"打回重做"。
- **token 估算对 mock 是 `字符数/4`**，真实 provider 走 API 返回的 usage。
- **缓存命中不产生费用，但 token 仍然计入统计。** 这是刻意的：费用是"这次花了多少钱"，token 是"多少信息流过了世界态"。`diff` 会强制打印同口径成本对比，避免总账误导（见 §6.1）。

---

## 11. 三条不要做

1. **别先做拖拽 UI。** 先 DSL + CLI，UI 是 DSL 的投影。
2. **别养一堆 provider SDK。** 差异化不在接入层。
3. **别把编排逻辑写回 TypeScript/Python。** 那就退回 LangGraph 了——工作流必须是数据，否则重放、diff、自适应绑定全部无从谈起。
