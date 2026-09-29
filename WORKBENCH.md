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

先读取材料和版本，再更新。以下 ID 和版本号均应替换成命令真实返回值：

```bash
npm run --silent workbench -- memo list --tag 待编 --json
npm run --silent workbench -- workspace create --memo MEMO_ID --json
npm run --silent workbench -- workspace get WORKSPACE_ID --json
npm run --silent workbench -- material set WORKSPACE_ID --memo MATERIAL_ID_1,MATERIAL_ID_2 --base-version 1 --json
npm run --silent workbench -- draft update WORKSPACE_ID --file draft.md --base-version 2 --json
npm run --silent workbench -- draft diff WORKSPACE_ID --json
```

`workspace get` 返回完整来源、草稿、已选择材料、对话和当前 `version`。**每次成功修改都重新采用返回版本**。不要假定上面示意的版本号适用于实际会话，其他窗口也可能同时修改工作区。

正文支持 `--file PATH`、`--stdin` 或 `--text TEXT`，三选一。文件或标准输入适合 Markdown、多行和包含特殊字符的正文。草稿更新替换全文，空正文也会保存，发布前请检查差异。

Codex 可以在当前对话中分析材料，再将结果写回工作台，不需要额外配置 AI API。若希望留存讨论过程：

```bash
npm run --silent workbench -- message add WORKSPACE_ID --role assistant --file analysis.md --base-version CURRENT_VERSION --json
```

材料列表采用整体替换；清空材料需要显式传入 `--memo ""`。来源的 ID、日期、链接应保留在草稿或讨论中，便于核实。工作区材料提供明确引用上下文。Web 收到变更通知后自动刷新；如果页面存在尚未保存的输入，会保留输入并提示外部更新，避免覆盖用户正在编辑的内容。

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

置顶标签默认依次为「待编、概要、想法、摘要、资源」。查看、设置共享配置：

```bash
npm run --silent workbench -- settings get --json
npm run --silent workbench -- settings set --file settings.json --json
```

`settings.json` 的完整结构：

```json
{"pinnedTags":["待编","概要","想法","摘要","资源"],"refreshSeconds":60}
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

工具均以 `workbench_` 开头，覆盖笔记/标签查询、工作区、草稿、材料、对话、任务、设置和变更读取。`workbench_changes_wait` 最多等待 30 秒，适合短期等待；持续监听使用 CLI。所有 MCP 修改标记为 `mcp`，与 Web 和 CLI 共享版本检查。该适配器仅提供 stdio，不另建远程 HTTP MCP 服务。

## 退出码和诊断

- `0`：成功。普通命令 stdout 为 JSON；`changes watch` 为逐行 JSON。
- `1`：服务端业务错误或不可解析的响应。
- `2`：参数、输入文件或请求校验错误。
- `3`：版本或远端内容冲突，需要重新读取并处理。
- `4`：无法连接本地服务。

错误以 `{"error":{"code":"...","message":"...","details":{}}}` 写入 stderr，失败时不向 stdout 混入日志。`--help` 输出命令说明。

服务默认用于本机受信任的 Web 和 Agent。直接把端口暴露到公网前需要单独设计身份验证和访问控制。
