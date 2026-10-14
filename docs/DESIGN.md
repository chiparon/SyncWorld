# Syncw 设计（v3）

> **状态：milestone 1 已经实现，第 2 节的验收场景已经跑通（2026-10-14）。**
>
> 本文取代 v2 草稿和 M0 的文档。v2 设想用 DeepSeek 自建 agent 循环，从未提交。M0 是 DeepSeek 写的模型路由流水线，保存在 git tag `m0-deepseek`。旧文档可以这样查看：`git show m0-deepseek:docs/DESIGN.md`、`git show m0-deepseek:docs/AGENT-MESH.md`。

---

## 1. 目标

Syncw 让多个 AI agent 像一个小公司一样协作：

- **伙伴（partner）**：agent 之间互相发消息，可以讨论、反对，最后达成一致。
- **员工（employee）**：一个 agent 可以雇一个新 agent，给它一份岗位说明和一个任务，也就是 prompt。新 agent 干完活后汇报结果。
- **角色（role）**：scheduler 和 verifier 是固定角色，其他角色由雇主在雇人时现场定义。

**资源策略**：按各家模型的长处和成本分工。

- **Claude** 判断力强，但走 API 按量计费，所以只做判断：拆任务、写任务说明、审查、拍板，token 尽量少用。
- **GPT** 通过 Codex CLI 使用你的 ChatGPT 订阅，执行能力强，额度也充足，所以负责执行：读代码、写代码、跑测试、反复修改。
- **DeepSeek** 以后作为便宜的补充。

这样分工还有一个额外的好处：GPT 写、Claude 审，天然就是不同模型家族之间的交叉检查。

**暂不考虑**：图形界面、跨机器运行，以及自动选模型（M0 的 binding 引擎）。

---

## 2. 全景

```
你
 -> Claude Code 会话 = scheduler：拆任务、写任务说明、拍板
      通过 post office（一个 MCP server）派活、收结果
      -> Codex worker 1：在自己的 git worktree 里干活
      -> Codex worker 2：同上，可以并行
      -> ……
 -> verifier = Claude Code 的 subagent：审 diff、跑测试，只汇报，不修改
```

milestone 1 的验收场景：

1. 你给 scheduler 一个真实的开发任务。
2. scheduler 把任务拆成两块，调用 `spawn_agent` 雇两个 Codex worker 并行开工。
3. 两个 worker 各自在自己的 worktree 和分支上完成工作，并按固定格式返回结果。
4. scheduler 让 verifier 审查每个 worker 的 diff，并跑测试。
5. verifier 发现一个问题，scheduler 用 `send_message` 让对应的 worker 修改。这一步续接的是 worker 原来的会话，它记得之前做过什么。
6. 全部通过后，scheduler 合并两个分支。

---

## 3. 概念

| 术语 | 含义 |
|---|---|
| **Agent** | 有名字的工作者，比如 `engineer-1`。它有自己的角色和会话历史，会话历史就是它的记忆。 |
| **引擎（engine）** | 驱动 agent 的软件。milestone 1 里，scheduler 和 verifier 用 Claude Code，worker 用 Codex。以后可以加 DeepSeek。 |
| **角色（role）** | 岗位说明：做什么、怎么做、要注意什么。scheduler 和 verifier 是固定角色；worker 的角色由雇主现场写，或者套用 `roles/` 里的模板。 |
| **任务（task）** | 雇人时交代的活，包括目标、验收标准、约束和背景资料。 |
| **结果（result）** | worker 每一轮结束时按固定格式返回的汇报，包括状态、摘要、细节、改了哪些文件，以及还没解决的问题。 |
| **Post office** | 一个 MCP server，是普通代码，不是 AI。它负责雇人（启动 worker）、转发消息、收结果、管理 worktree，记录所有事件，并执行各项限制。 |
| **Worktree** | 每个 worker 独占一个 git worktree 和一个分支，互不干扰。 |
| **公告板（board）** | 存放共享的关键决定，比如接口和数据格式，所有 agent 都读同一份。来自 M0 的 `world.ts`。*（milestone 2）* |

---

## 4. 角色

**固定角色**：都需要判断力，由 Claude 担任。

| 角色 | 由谁担任 | 职责 |
|---|---|---|
| **scheduler** | 你正在对话的 Claude Code 会话 | 理解你的目标，拆成任务，写任务说明，雇 worker，看结果，决定下一步，合并成果，向你汇报。它只负责协调，自己不写大量代码。 |
| **verifier** | Claude Code 的 subagent（`.claude/agents/verifier.md`） | 审查别人写的东西：读 diff、跑测试、对照验收标准。审查结论要么是 `APPROVED`，要么列出具体问题。它不修改代码。 |

**现场定义的角色**：scheduler 雇人时有两种方式：
- 套用 `roles/` 里的模板，比如 `engineer`、`architect`、`researcher`；
- 直接写一段专门为这个任务定制的岗位说明（brief）。

**权限规则**：被雇的 agent，权限不能超过雇主。milestone 1 里 worker 还不能雇人；到 milestone 2 开放 worker 雇人时，这条规则开始生效。

---

## 5. Post office 的工具

scheduler 通过 MCP 调用下面这些工具。

| 工具 | 作用 |
|---|---|
| `spawn_agent(task, role?, brief?, repo?, base?)` | 雇一个 Codex worker：创建 worktree 和分支，启动 worker，然后立即返回它的名字（比如 `engineer-1`）、分支和 worktree 路径，不等它干完。`repo` 指定在哪个仓库里干活，默认是 post office 的当前目录。 |
| `send_message(to, text)` | 给 worker 发后续消息。worker 空闲时，会马上开始新的一轮（续接原来的会话）；正在干活时，消息先排队，等这一轮结束再送达。 |
| `wait(agents?, timeout_s?)` | 等结果：返回已经完成的那一轮结果；超时就返回"还在运行"。 |
| `list_agents()` | 团队现状：名字、角色、状态、分支、用时，以及最近一次结果的摘要。 |
| `cancel_agent(name)` | 中止正在运行的 worker。 |
| `close_agent(name, delete_branch?)` | 收尾：合并之后或者放弃时，删除 worker 的 worktree。 |

**任务格式**（`spawn_agent` 的 `task` 参数）：

```yaml
goal: 为 post office 实现 Codex 引擎       # 必填：要的是什么结果，而不是怎么做
acceptance:                               # 怎样才算完成
  - npm test 全部通过
  - 能启动、续接、取消一个 codex 进程
constraints:
  - 只改 src/engines/ 和 test/engines/
context:                                  # 动手前先读这些
  - docs/DESIGN.md §6
  - src/schema/types.ts
```

**结果格式**（worker 每一轮结束时的输出，由 `codex exec --output-schema` 强制）：

```yaml
status: done            # done | failed | blocked
summary: 实现了 CodexEngine，支持启动、续接和取消。
details: ……
files_changed: [src/engines/codex.ts, test/engines/codex.test.ts]
open_questions: []
```

post office 不完全相信 worker 的自述。它会在结果上补充几项可靠的事实：`git diff --stat`、事件流里实际改动的文件、用时，以及这一轮的 commit。

**节省 Claude 的 token**：`wait` 只返回摘要和 diff 统计，scheduler 和 verifier 需要时再去看完整的 diff。worker 的完整工作过程只保存在日志里，不回传给 Claude。

---

## 6. 运行机制

**雇人**（`spawn_agent`）：
1. 在 `<仓库所在目录>/<仓库名>.worktrees/<agent 名>` 创建 worktree，分支名为 `syncw/<agent 名>`，基于 `base`（默认是当前分支的 HEAD）。
2. 把岗位说明、任务和通用规则拼成 prompt。通用规则包括：你是谁、谁雇了你；只在这个 worktree 里工作；不要 push；最后按格式返回结果。
3. 在后台启动 worker，并关闭 stdin（否则 codex 会一直等待 stdin 输入）：
   `codex exec --json -s danger-full-access -c 'approval_policy="never"' -C <worktree> --output-schema <schema> -o <结果文件> "<prompt>"`
4. 从事件流里的 `thread.started` 事件记下会话 id，供以后续接使用。

**每一轮结束时**：post office 读取结果文件，把这一轮的改动自动 commit 到 worker 的分支，提交信息为 `<agent 名> 第 n 轮：<摘要>`。然后记录 diff 统计，把结果交给正在等待的 `wait`。

**续接**（`send_message`）：在 worker 的 worktree 目录里运行
`codex exec resume <会话 id> -c 'sandbox_mode="danger-full-access"' -c 'approval_policy="never"' --json --output-schema <schema> -o <结果文件> "<消息>"`。
试水时发现：续接时如果不显式指定沙箱模式，会退回用户配置里的默认值。所以虽然现在选择了不加沙箱，续接时仍然显式指定，以后改策略时只需改一处。

**规则**：
- 一个 worker 同一时间只跑一轮。这期间收到的消息先排队，下一轮一起送达。
- post office 会把所有 agent 的状态写到磁盘，重启后默认接着当前仓库最近一次尚未结束的运行，之前还在运行的 worker 标记为“中断”，可用 `send_message` 续接；用 `--new-run` 或关闭上一轮的所有 agent 后重启，可以另起一轮。健康检查或第二个会话不会打扰仍在运行的 post office，没有雇人就不会创建新的运行目录。

**限制**：由 post office 强制执行，agent 无法修改。

| 限制 | 默认值 | 防止什么 |
|---|---|---|
| `max_parallel` | 4 | 同时运行的 worker 太多 |
| `max_agents` | 12 | 一次运行里雇的人太多 |
| `max_turns` | 10 | 一个 worker 来回修改，没完没了 |
| `turn_timeout` | 30 分钟 | 某一轮卡死 |

---

## 7. 安全

你选择了 **B：worker 不加沙箱**，这和你平时使用 Codex 的方式一致。这意味着，理论上 worker 能改你电脑上的任何文件。我们接受这个风险，并用下面这些办法兜底：

- 每个 worker 独占一个 worktree 和分支，每一轮的工作都会自动 commit，全程可查、可回退。
- prompt 里明确要求 worker 只在自己的 worktree 里工作，不要 push。
- 没有经过 verifier 审查的东西，一律不合并。
- 所有事件都记录在日志里。

worker 沿用你的 Codex 配置（`~/.codex/config.toml`），包括模型 `gpt-6-astra` 和推理强度。

---

## 8. 你能看到什么

- **在对话里**：scheduler 会告诉你雇了谁、每个人在做什么、结果怎样，有需要时也会向你提问。你也可以随时让它调用 `list_agents`。
- **在终端里**：`npm run status` 显示最近一次运行的团队现状。它只读取磁盘上的记录，所以 post office 没在运行时也能用。
- **在磁盘上**：`runs/<运行 id>/` 目录下有：
  - `agents.json`：所有 agent 的状态
  - `<agent 名>/events.jsonl`：Codex 的完整事件流
  - `<agent 名>/turn-<n>.json`：每一轮的结果
- **在 git 里**：每个 worker 一个分支，每一轮一个 commit。

---

## 9. 代码结构

```
AGENTS.md                      每个 Codex worker 都会自动读取的编码规范
roles/                         worker 角色模板：engineer.md、architect.md、researcher.md
.claude/agents/verifier.md     verifier subagent（安装时复制到 ~/.claude/agents/）
src/
  schema/types.ts              Task、Result、Agent 等共享类型（也就是"合同"）
  schema/result.schema.json    给 codex --output-schema 用的结果格式
  engines/codex.ts             启动、续接、取消 codex 进程，解析事件流
  postoffice/registry.ts       agent 登记、状态管理、持久化到磁盘，以及运行日志
  postoffice/worktrees.ts      创建和清理 worktree、自动 commit、diff 统计
  postoffice/prompt.ts         把角色、任务、通用规则拼成 prompt
  postoffice/core.ts           post office 的核心逻辑：雇人、转发、等待、各项限制
  postoffice/server.ts         MCP server，把第 5 节的工具一一对应到 core.ts
  postoffice/main.ts           post office 的启动入口（stdio）
  status/read.ts               从 runs/ 读出一次运行的团队现状，只读
  status/format.ts             把团队现状排成终端里看的文本
  cli/syncw.ts                 命令行入口：syncw status
  runtime/world.ts             公告板（沿用 M0，milestone 2 使用）
test/
  fake-codex/                  一个假的 codex 程序，测试时不调用真的 Codex
```

新增依赖：`@modelcontextprotocol/sdk`（官方的 MCP SDK）。

**接入 Claude Code**：post office 在用户级注册（`claude mcp add --scope user syncw -- node <路径>/src/postoffice/server.ts`），这样在任何项目里都能用。verifier subagent 也放在用户级（`~/.claude/agents/`）。scheduler 的工作守则通过 MCP server 的 instructions 下发，接上就生效。

**M0 代码的去留**：
- 保留：`src/runtime/world.ts` 及其测试。
- 删除，需要时可以从 tag `m0-deepseek` 恢复：`src/runtime/` 下的 `engine.ts`、`binding.ts`、`requirements.ts`、`refs.ts`、`cache.ts`、`trace.ts`；`src/report.ts`、`src/util/glob.ts`、`src/context.ts`、`src/cli.ts`；旧的 `src/schema/`、`src/providers/`；根目录下的 `agents/`、`workflows/`、`models/`、`providers/`、`scripts/demo.ts`、`syncw.yaml`；以及对应的测试。其中 `openai-compat.ts` 会在 milestone 3 接入 DeepSeek 时恢复。M0 的 `trace.ts` 是为一次性运行设计的，运行日志改由 `registry.ts` 直接追加写入，更简单。

---

## 10. 里程碑

| | 做什么 | 验收 |
|---|---|---|
| **1** | post office（MCP server）、Codex 引擎、verifier subagent、worker 角色模板 | 跑通第 2 节的场景：两个 Codex worker 并行完成一个真实任务，verifier 审查，续接修改一次，最后合并 |
| **2** | worker 之间直接通信（Codex 连上 post office 的 MCP，获得 `send_message`）、公告板、worker 雇人（带权限收窄） | 两个 worker 不经过 scheduler，直接商定一个共同的接口 |
| **3** | 无人值守的 scheduler（不需要开着对话）、DeepSeek 引擎 | 给一个目标，没人看着也能跑完 |

---

## 11. 怎么把它造出来

不把整份文档一次性交给 Codex。一次给得太多、留的空白太多，执行的人只能自己猜，猜错就会跑偏。我们的做法是**用这套模式来造它自己**：

1. **我先写"合同"**：`schema/types.ts`、`result.schema.json`、工具接口，以及假的 codex 程序。这部分量不大，但最关键：几个 worker 照着同一份合同写代码，就不会做出互相矛盾的隐含决定。
2. **拆成小任务，派给 Codex worker 并行完成**，每个任务都带验收测试：
   - 任务 A：Codex 引擎（`engines/codex.ts`）
   - 任务 B：登记、worktree 和日志（`postoffice/registry.ts`、`worktrees.ts`）
   - 任务 C：post office 核心、prompt 拼装和 MCP server（`core.ts`、`prompt.ts`、`server.ts`），等 A、B 合并之后再做
   - 任务 D：角色模板、verifier subagent、README（这部分是写 prompt，需要判断力，由我来写）

   删除 M0 代码是机械操作，已经和"合同"一起完成。
3. **我当 scheduler 和 verifier**：审 diff、跑测试、要求修改，合格后合并。

这一步相当于先手工扮演一遍 post office，边造边验证这个模式哪里顺、哪里卡。milestone 1 完成以后，milestone 2 就用 post office 本身来造。

开发在新分支 `dev` 上进行。worker 的分支从 `dev` 分出，再合并回 `dev`。`master` 保持不动，等 milestone 1 验收后再合并。

---

## 12. 风险

- **Codex 偏离合同**：合同先行，任务拆小，每个任务带测试，逐个验收。
- **几个 worker 改到同一个文件**：任务按模块划分，共享的类型由我先写好。
- **worker 不加沙箱**：见第 7 节。
- **Claude 的 token 成本**：结果只回传摘要；verifier 先看 diff 统计，需要时才看完整 diff。
- **Windows 上的小问题**：Codex 执行命令的输出是 GBK 编码，会出现乱码。所以 post office 不解析命令输出，改动一律以事件流和 `git diff` 为准。

---

## 13. 开放问题

每个问题都有默认做法（加粗）。不同意的地方请告诉我。

1. **worktree 放在哪里？** 默认：**放在仓库旁边的 `<仓库名>.worktrees/` 目录里**，比如 `E:\Eproject\Syncw.worktrees\engineer-1`。
2. **verifier 用哪个 Claude 模型？** 默认：**Sonnet**。它比 scheduler 便宜，用来做常规审查；遇到重要的审查，由 scheduler 决定改用 Opus。
3. **worker 用什么配置？** 默认：**沿用你的 Codex 配置**，即 `gpt-6-astra`、推理强度 xhigh。另一种做法是给 worker 单独一套配置，比如简单任务用更低的推理强度，跑得更快。
