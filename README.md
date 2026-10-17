# Syncw

**Synchronized World**：一个给 AI agent 用的 post office。Claude 当 scheduler，负责拆任务、写任务说明、审查和拍板；Codex worker 负责干活，每个 worker 在自己的 git worktree 里工作；两者之间通过一个 MCP server 通信。

```
你
 -> Claude Code 会话 = scheduler：拆任务、写任务说明、拍板
      通过 post office（MCP server）派活、收结果
      -> Codex worker 1：在自己的 git worktree 和分支上干活
      -> Codex worker 2：同上，可以并行
 -> verifier = Claude Code subagent：审 diff、跑测试，只汇报不修改
```

这样分工是因为：Claude 判断力强，但按 token 计费，所以只用来做判断；GPT 通过你的 ChatGPT 订阅使用 Codex，额度充足，所以负责执行。GPT 写、Claude 审，同时也是不同模型家族之间的交叉检查。

完整设计见 **[docs/DESIGN.md](docs/DESIGN.md)**。

## 状态

milestone 1 的代码已经完成：post office、Codex 引擎、MCP server、角色模板、verifier，以及查看团队现状的 `syncw status` 命令。共 135 个测试：134 个通过，1 个要用真的 Codex，默认跳过。

验收场景（[DESIGN §2](docs/DESIGN.md)）已经在真实的 Claude Code 会话里跑通，用的任务就是 `syncw status` 命令本身：scheduler 先写好合同，再雇 2 个 Codex worker 并行开工；verifier 分别审查，各提出了问题；scheduler 用 `send_message` 让原来的 worker 在原会话里修改；最后合并两个分支。

milestone 1 的代码本身就是用这套方式造出来的：Claude 先写好"合同"（`src/schema/types.ts`），再把实现派给 4 个 Codex worker 并行完成，审查通过后合并。

## 准备

- Node ≥ 22.18（原生运行 TypeScript，不需要构建）
- git
- Codex CLI，并用 ChatGPT 账号登录：运行 `codex login status`，应该显示 `Logged in using ChatGPT`
- Claude Code

```powershell
cd E:\Eproject\Syncw
npm ci
npm run verify          # 类型检查 + 全部测试
```

## 接入 Claude Code

只在当前项目里注册（local 作用域）：

```powershell
cd E:\Eproject\Syncw
claude mcp add --scope local syncw -- node E:\Eproject\Syncw\src\postoffice\main.ts
```

注册后要重启 Claude Code，新工具才会加载。worker 默认在 Claude Code 当前所在的仓库里干活；用 `--repo <路径>` 可以指定其他仓库。

verifier subagent 放在 `.claude/agents/verifier.md`，在这个项目里自动可用。

## 用法

在 Claude Code 里直接交代任务就行。scheduler 会自己调用这些工具：

| 工具 | 作用 |
|---|---|
| `spawn_agent` | 雇一个 Codex worker，立即返回，不等它干完 |
| `wait` | 收结果，每一轮只汇报一次 |
| `send_message` | 给 worker 发后续要求，worker 记得之前的工作 |
| `list_agents` | 查看团队现状 |
| `cancel_agent` | 中止一个 worker |
| `close_agent` | 合并之后删除 worker 的 worktree |

worker 的角色可以套用 `roles/` 里的模板（`engineer`、`architect`、`researcher`），也可以由 scheduler 现场写。

## 去哪里看

- `npm run status`：最近一次运行的团队现状，包括每个 agent 的角色、状态、轮数、最近一次结果和任务目标。还没雇人的空运行会被跳过。它只读取磁盘上的记录，所以 post office 没在运行时也能用。`npm run status -- --run <运行 id>` 查看指定的一次运行，`npm run status -- --json` 输出原始数据。
- `runs/<运行 id>/agents.json`：所有 agent 的状态
- `runs/<运行 id>/<agent>/`：每一轮的 prompt、结果，以及 Codex 的完整事件流
- git 分支 `syncw/<agent>`：每一轮的工作都会自动 commit，作者是 `<agent> (syncw)`
- worktree：在仓库旁边的 `<仓库名>.worktrees/<agent>/` 目录里

## 配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `SYNCW_MAX_PARALLEL` | 4 | 同时运行的 worker 数 |
| `SYNCW_MAX_AGENTS` | 12 | 一次运行最多雇多少个 worker |
| `SYNCW_MAX_TURNS` | 10 | 每个 worker 最多跑几轮 |
| `SYNCW_TURN_TIMEOUT_MS` | 1800000 | 单轮超时（30 分钟） |
| `SYNCW_RUNS_DIR` | `runs/` | 运行记录放在哪里 |
| `SYNCW_CODEX_COMMAND` | 自动查找 | 启动 codex 的命令，格式是 JSON 数组 |

post office 重启后，默认接着当前仓库最近一次尚未结束的运行：之前正在跑的 worker 会被标记为"中断"，之后可以用 `send_message` 续接。健康检查（如 `claude mcp list`）或第二个会话不会打扰仍在运行的 post office；没有雇人就不会创建新的运行目录。用 `--new-run` 可以另起一轮；如果上一次的 agent 都已关闭，也会自动另起一轮。

## 安全

worker **不加沙箱**，这和你平时用 Codex 的方式一致，所以理论上它们能改电脑上的任何文件。兜底措施：
- 每个 worker 独占一个 worktree 和分支；
- 每一轮都自动 commit；
- 没有经过审查的东西一律不合并；
- 所有事件都记在日志里。

详见 [DESIGN.md §7](docs/DESIGN.md)。

## 开发

- 测试用 `test/fake-codex/` 里的假 codex，不会调用真的 Codex。
- `SYNCW_REAL_CODEX=1 npm test` 会额外用真的 Codex 跑一个集成测试。这个测试会在 `~/.codex/config.toml` 里留下一条临时仓库的信任记录，可以手动删掉。
- 代码规范见 [AGENTS.md](AGENTS.md)，每个 Codex worker 都会自动读取它。

## 历史

M0 是 DeepSeek 写的一个模型路由流水线，它误解了项目目标。M0 保存在 git tag `m0-deepseek`，可以用 `git show m0-deepseek:README.md` 查看。
