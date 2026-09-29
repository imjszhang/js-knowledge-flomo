# Web、CLI 与 Agent 共用的 flomo 工作台

工作台使用 TypeScript、Node.js、Fastify、React 和 SQLite。Web、CLI、MCP 通过同一个后台服务操作草稿、材料、对话与任务，服务保存版本和变更记录。正式笔记仍在 flomo，本地数据库还保存未发布的草稿和加工过程，需一并备份。数据库默认位于 `data/cache.db`，可通过 `WORKBENCH_DB_PATH` 配置；备份时先停止服务，或使用支持 SQLite 在线备份的工具，避免遗漏 WAL 中的写入。

## 启动

需要 Node.js 22.12 或更高版本。安装依赖后开发：

```bash
npm install
npm run dev
```

正式运行：

```bash
npm run build
npm start
```

默认访问 `http://127.0.0.1:3000`。`npm run dev:server` 和 `npm run dev:web` 可分别启动后端和前端。CLI、MCP 使用 `FLOMO_WORKBENCH_URL` 指定已运行的服务，默认同上。请使用同一服务地址；不同服务实例不构成分布式同步。

原有 CLI 和 flomo MCP 入口保留兼容用途。新的共享加工功能使用 `npm run workbench -- ...` 和 `npm run mcp:workbench`。下文省略 npm 前缀的 `flomo` 是命令示意；可以将 `npm run --silent workbench --` 设为本地别名。Agent 应使用 `--silent`，避免 npm 自身输出脚本提示污染 JSON。

## 在 Codex 中加工一条待编

Web 按 Codex 右侧面板设计：优先恢复当前工作，五个置顶标签和笔记搜索放在切换入口中；「笔记、材料、草稿」一次显示一个视图。先在页面选择笔记、写明这次要完成的目标，再在 Codex 里提出加工要求。CLI 可以直接读取这份共享上下文：

```bash
npm run --silent workbench -- context get --json
npm run --silent workbench -- workspace get current --json
```

`context get` 返回 `workspaceId`、当前 `view`、选择状态的 `revision` 和完整 `workspace`。工作区内包含来源、加工目标 `goal`、草稿、候选材料 `materialCandidates`、已选材料 `materials`、待判断问题 `decisions`、讨论和内容 `version`。问题中的 `answer` 为 `null` 表示尚未回答。没有当前工作时 `workspaceId` 和 `workspace` 为 `null`，使用 `current` 返回 `NO_ACTIVE_WORKSPACE`。

所有以工作区 ID 为参数的命令都可以使用 `current`，包括 `job list --workspace current`。读取无需附加参数；**修改 `current` 必须附上刚读到的 `--context-revision`**。如果用户已切换工作或视图，就返回 `CONTEXT_CONFLICT`，避免两份笔记恰好具有相同内容版本时误写。校验后只解析一次真实 ID，后续请求固定操作该笔记。

Agent 进行较长时间分析时，应保存读取结果中的真实 `workspace.id`，并用这个 ID 写回，无需附加选择版本，也无需人工复制 ID。不要在遇到上下文冲突时盲目采用新 revision；先核实本次结果属于哪条笔记。

以下 ID 和版本号均应替换成命令真实返回值。**每次成功修改都重新采用返回版本**；版本冲突时重新读取并比较，不能只换版本号覆盖。

```bash
# 在已有笔记上明确本次加工目标
npm run --silent workbench -- workspace goal current --text "明确账号服务谁、解决什么问题，以及第一篇内容" --base-version CURRENT_VERSION --context-revision CONTEXT_REVISION --json
# 保存结果，并告诉页面这次主要改了什么
npm run --silent workbench -- draft update WORKSPACE_ID --file draft.md --summary "补充目标读者和两个科研案例" --base-version CURRENT_VERSION --json
npm run --silent workbench -- draft history WORKSPACE_ID --json
npm run --silent workbench -- draft diff WORKSPACE_ID --json
```

正文支持 `--file PATH`、`--stdin` 或 `--text TEXT`，三选一。文件或标准输入适合 Markdown、多行和包含特殊字符的正文。草稿更新替换全文，空正文也会保存，发布前请检查差异。

`draft history` 返回最近 50 次草稿修改，包含修改前后正文、摘要、操作者和版本。页面可以查看 Agent 新改了什么；用户尚未保存的输入会保留，外部修改由用户查看、比较后再采用。

Codex 可以在当前对话中分析材料，再将结果写回工作台，不需要额外配置 AI API。若希望留存讨论过程：

```bash
npm run --silent workbench -- message add WORKSPACE_ID --role assistant --file analysis.md --base-version CURRENT_VERSION --json
```

### 给出有理由的材料推荐，让用户判断

先检索并阅读笔记全文，再把推荐理由写入工作台。`material propose` 的文件内容是 JSON 数组：

```json
[
  {"memoId":"MATERIAL_ID_1","reason":"提供无编程背景研究者的实际案例","relation":"example"},
  {"memoId":"MATERIAL_ID_2","reason":"质疑把自动生成结果等同于完成科研的假设","relation":"counterpoint"}
]
```

```bash
npm run --silent workbench -- material propose WORKSPACE_ID --file materials.json --base-version CURRENT_VERSION --json
```

`relation` 支持 `support`（支持观点）、`counterpoint`（不同角度）、`example`（案例）、`background`（背景）。用户在材料页阅读原文，选择「用于本次加工」或「暂时不用」，状态分别为 `selected`、`dismissed`；新推荐为 `proposed`。Codex 下一次读取工作区就能看到这些选择。CLI 也可以操作：

```bash
npm run --silent workbench -- material decide WORKSPACE_ID --memo MATERIAL_ID_1 --status selected --base-version CURRENT_VERSION --json
```

问题应具体到当前笔记，保存成 `decision.json`：

```json
{"question":"这个账号主要帮助谁？","options":["没有编程经验的研究生","刚接触 AI 的独立研究者"]}
```

```bash
npm run --silent workbench -- decision add WORKSPACE_ID --file decision.json --base-version CURRENT_VERSION --json
# 用户可在页面选项中作答或补充自己的答案；CLI 也能保存答案
npm run --silent workbench -- decision answer WORKSPACE_ID --decision DECISION_ID --text "没有编程经验的研究生" --base-version CURRENT_VERSION --json
```

问题最多有 6 个选项，`options` 可省略。推荐和问题文件不要包含版本字段；版本通过 `--base-version` 单独指定。

这些选择、目标和回答保存于同一服务，**不会主动向 Codex 对话发送消息或自动唤醒 Agent**。用户可以在 Codex 中说“我选好了，继续”，Agent 重新读取工作区后接着处理；连续执行中的 Agent 也可读取变更通知后刷新上下文。网页中的 AI 讨论保留为独立使用时的可选功能。

仍可使用 `material set WORKSPACE_ID --memo ID1,ID2 --base-version N` 整体替换已选材料；清空材料需要显式传入 `--memo ""`。来源的 ID、日期、链接应保留在草稿或讨论中，便于核实。

### 从 CLI 打开或切换工作

```bash
npm run --silent workbench -- memo list --tag 待编 --json
npm run --silent workbench -- workspace create --memo MEMO_ID --json
npm run --silent workbench -- context get --json
npm run --silent workbench -- context set --workspace WORKSPACE_ID --view materials --base-revision CONTEXT_REVISION --json
```

`view` 可选 `note`、`materials`、`draft`。`--workspace none` 清空当前选择。`--base-revision` 对应选择状态的 `revision`，最初可以为 0，**与草稿等内容的 `--base-version` 是不同计数器**。选择被其他入口改变时返回冲突，重新读取上下文再决定是否切换。Web 通过共享上下文恢复当前工作；同一服务的多个页面也共享这份选择。

## 发布与冲突

`draft publish` 会**更新原来的 flomo 笔记**。先查看差异、确认最终内容，再执行：

```bash
npm run --silent workbench -- draft publish WORKSPACE_ID --expected-version CURRENT_VERSION --idempotency-key publish-WORKSPACE_ID-vCURRENT_VERSION --json
npm run --silent workbench -- job get JOB_ID --json
```

发布和内置 AI 操作必须提供 `--idempotency-key`。网络结果不明时，使用**原来的 key、原来的版本和完全相同的请求**重试，以查回同一个任务；不要生成新 key 盲目重复发布。返回任务不代表远端已保存，需通过 `job get` 确认 `succeeded`。若状态为 `uncertain`：

```bash
npm run --silent workbench -- job reconcile JOB_ID --json
```

`reconcile` 读取远端，核实原发布是否成功，不会重新发送写操作。内容不一致时保持 `uncertain`，继续阻止新的发布，因为早先超时的请求仍可能稍后提交。

如果需要解除这次不确定发布的阻塞，先在 flomo 里人工检查并处理原文，然后显式执行：

```bash
npm run --silent workbench -- job abandon JOB_ID --base-version CURRENT_WORKSPACE_VERSION --acknowledge --json
```

这个操作只将本地任务标记为已放弃，不会修改 flomo，也不能取消之前发出的远端请求；**原请求仍可能稍后生效**。不可把它作为核对失败后的自动补救。放弃后先 `workspace refresh`、比较差异并确认基准，再决定是否发起新发布。MCP 对应 `workbench_job_abandon`，同样要求明确确认和当前工作区版本。

工作区版本冲突返回退出码 `3` 和 `VERSION_CONFLICT` 等结构化错误。请重新读取工作区，比较自己的待保存内容与最新内容，合并后再写入。不要只换成新版本号覆盖他人内容。

如果 flomo 原文在加工期间变化，先检查并合并：

```bash
npm run --silent workbench -- workspace refresh WORKSPACE_ID --json
npm run --silent workbench -- draft diff WORKSPACE_ID --json
# 比较 original、remote、draft 后，先把合并后的内容保存为草稿。
npm run --silent workbench -- draft update WORKSPACE_ID --file merged.md --base-version CURRENT_VERSION --json
# 明确接纳已查看过的远端原文为新基准；草稿不会被替换。
npm run --silent workbench -- workspace rebase WORKSPACE_ID --base-version NEW_VERSION --json
```

flomo 上游若不支持条件写入，远端检查与实际更新之间仍有短暂竞争窗口；工作台可以检测检查时已存在的修改，但无法保证上游不存在这类窗口。

## 同步范围和变更订阅

本地加工状态由同一服务统一写入，Web 通过 SSE 接收变更，CLI 可以订阅 NDJSON：

```bash
npm run --silent workbench -- changes list --after 0 --json
npm run --silent workbench -- changes watch --after LAST_CHANGE_ID --json
```

`changes list` 每次最多返回 1000 条；需要历史全量时继续以最后一条 ID 查询，直到不足 1000 条。`changes watch` 自动补完这些分页。每行包含持久化的 `id`、对象类型、对象 ID、变更类型、操作者（`web`、`cli`、`mcp`）和时间。订阅自动重连，并从最后收到的 ID 补查变更、去重。消费者应在成功处理后保存自己的游标，重启时通过 `--after` 恢复。通知不包含完整工作区，收到通知后重新读取对应对象。

flomo 侧提供按需搜索、笔记全文读取和已打开工作区来源检查。**搜索结果和本地缓存不代表完整知识库**：搜索结果中的 `possiblyLimited`、标签结果中的 `truncated` 和工作区中的 `lastCheckedAt` 用于说明范围与新鲜程度。当前没有承诺全库增量镜像、删除同步或 flomo 实时推送。`refreshSeconds: 0` 关闭定期检查，其他可用值为 30～3600 秒。

置顶标签默认依次为「待编、概要、想法、资源」。查看、设置共享配置：

```bash
npm run --silent workbench -- settings get --json
npm run --silent workbench -- settings set --file settings.json --json
```

`settings.json` 的完整结构：

```json
{"pinnedTags":["待编","概要","想法","资源"],"refreshSeconds":60}
```

配置只影响工作台导航和检查间隔，不修改 flomo 标签。

## 可选内置 AI

配置项目的 OpenAI 兼容 API 后，可在 Web 或 CLI 启动后台生成任务：

```bash
npm run --silent workbench -- ai run WORKSPACE_ID --prompt "结合已选材料，提出三个值得追问的问题，并标明来源" --base-version CURRENT_VERSION --idempotency-key ai-WORKSPACE_ID-UNIQUE_REQUEST --json
npm run --silent workbench -- job get JOB_ID --json
```

任务结果和状态由服务保存；命令退出不会取消生成。CLI 和 MCP 本身不直接调用模型，也不会保存 API 密钥。

## MCP 连接

先启动工作台服务，再将以下 stdio 配置添加到支持 MCP 的 Agent。请替换项目绝对路径；正式构建后也可使用 `node` 与 `dist/mcp-server/workbench.js`。

```json
{
  "mcpServers": {
    "flomo-workbench": {
      "command": "npx",
      "args": ["--no-install", "tsx", "/ABSOLUTE/PROJECT/mcp-server/workbench.ts"],
      "env": {"FLOMO_WORKBENCH_URL": "http://127.0.0.1:3000"}
    }
  }
}
```

当 Agent 的工作目录不在项目目录时，推荐使用构建后的绝对路径，避免 `npx` 无法定位项目依赖：

```json
{
  "mcpServers": {
    "flomo-workbench": {
      "command": "node",
      "args": ["/ABSOLUTE/PROJECT/dist/mcp-server/workbench.js"],
      "env": {"FLOMO_WORKBENCH_URL": "http://127.0.0.1:3000"}
    }
  }
}
```

工具均以 `workbench_` 开头，覆盖笔记/标签查询、工作区、草稿、材料、对话、任务、设置和变更读取。侧栏协作对应以下工具：

| 操作 | MCP 工具 |
| --- | --- |
| 读取、切换当前工作 | `workbench_context_get` / `workbench_context_set` |
| 更新加工目标 | `workbench_workspace_goal` |
| 推荐材料、保存选择 | `workbench_materials_propose` / `workbench_material_decide` |
| 提出问题、保存回答 | `workbench_decision_add` / `workbench_decision_answer` |
| 查看草稿改动记录 | `workbench_draft_history` |

工作区工具的 `id` 接受 `current`；修改时还必须传入读取上下文时得到的 `contextRevision`，或直接使用真实工作区 ID。更新草稿的 `summary` 可解释本次改动。`workbench_context_set` 接受 `workspaceId`（可以为 `null`）、`view` 和 `baseRevision`。

`workbench_changes_wait` 最多等待 30 秒，适合短期等待；持续监听使用 CLI。所有 MCP 修改标记为 `mcp`，与 Web 和 CLI 共享版本检查。该适配器仅提供 stdio，不另建远程 HTTP MCP 服务。

## 退出码和诊断

- `0`：成功。普通命令 stdout 为 JSON；`changes watch` 为逐行 JSON。
- `1`：服务端业务错误或不可解析的响应。
- `2`：参数、输入文件或请求校验错误。
- `3`：版本或远端内容冲突，需要重新读取并处理。
- `4`：无法连接本地服务。

错误以 `{"error":{"code":"...","message":"...","details":{}}}` 写入 stderr，失败时不向 stdout 混入日志。`--help` 输出命令说明。

服务默认用于本机受信任的 Web 和 Agent。直接把端口暴露到公网前需要单独设计身份验证和访问控制。
