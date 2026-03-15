# js-knowledge-flomo

> 以 flomo 为核心的知识管理工具 — MCP Client + MCP Server 双角色，AI 增强笔记洞察、整理与写作。
>
> 创建于 2026-03-15

## 架构

本项目同时扮演两个角色：

1. **MCP Client**：连接 flomo 官方 MCP Server (`https://flomoapp.com/mcp`)，通过 Streamable HTTP + OAuth 读写用户的 flomo 笔记
2. **MCP Server**：对外暴露增强工具，供 Cursor / Claude Desktop 等 AI 工具调用

```
Cursor/Claude ─── MCP ──→ [js-knowledge-flomo MCP Server]
                                    │
                                    ├── 透传 → [flomo MCP Server] → flomo 笔记
                                    │
                                    └── AI 加工 → [LLM API] → 洞察/标签/大纲
```

## 运行模式

### 1. CLI 模式

```bash
# 首次授权
node cli/cli.js auth

# 基础操作
node cli/cli.js write "想到一个产品方向" --tag "产品,思考"
node cli/cli.js search "产品设计"
node cli/cli.js tags

# AI 加工
node cli/cli.js insights --tag "产品" --period 30
node cli/cli.js outline "为什么小团队应该克制增长"
node cli/cli.js suggest-tags --limit 20
```

### 2. MCP Server 模式（供 Cursor 调用）

```bash
# stdio 模式（Cursor 推荐）
node mcp-server/index.mjs

# HTTP 模式
node mcp-server/index.mjs --http --port 8080
```

## Cursor MCP 配置

在项目根目录创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "js-knowledge-flomo": {
      "command": "node",
      "args": ["<项目路径>/mcp-server/index.mjs"],
      "env": {
        "FLOMO_MCP_URL": "https://flomoapp.com/mcp",
        "LLM_API_BASE_URL": "你的 LLM API 地址",
        "LLM_API_KEY": "你的 API Key",
        "LLM_API_MODEL": "gpt-4.1-mini"
      }
    }
  }
}
```

也可以在 Cursor 全局设置中配置：`~/.cursor/mcp.json`

## 工具清单

### 透传工具（直接操作 flomo）

| 工具 | 说明 |
|------|------|
| `memo_create` | 创建笔记 |
| `memo_update` | 更新笔记 |
| `memo_search` | 搜索笔记（关键词/标签/时间/语义） |
| `memo_batch_get` | 批量获取笔记 |
| `memo_recommended` | 相关笔记推荐 |
| `tag_tree` | 查看标签树 |
| `tag_search` | 搜索标签 |
| `tag_rename` | 重命名标签 |

### AI 增强工具

| 工具 | 说明 |
|------|------|
| `generate_insights` | 发现笔记中的规律/主题/变化 |
| `track_evolution` | 追踪某话题的观点演变 |
| `find_connections` | 跨标签/跨时间关联分析 |
| `draft_outline` | 从笔记素材生成写作大纲 |
| `collect_material` | 搜集主题相关素材 |
| `suggest_tags` | 为无标签笔记建议标签 |
| `audit_tags` | 分析标签体系问题 |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FLOMO_MCP_URL` | flomo MCP 服务地址 | `https://flomoapp.com/mcp` |
| `LLM_API_BASE_URL` | LLM API 地址 | — |
| `LLM_API_KEY` | LLM API Key | — |
| `LLM_API_MODEL` | 模型名称 | `gpt-4.1-mini` |
| `DB_PATH` | 本地缓存数据库路径 | `./data/cache.db` |

## 目录结构

```
js-knowledge-flomo/
├── cli/
│   ├── cli.js                    # CLI 入口
│   └── lib/
│       ├── flomo-mcp-client.js   # flomo MCP Client（核心）
│       ├── auth.js               # OAuth 认证
│       ├── processor.js          # AI 知识加工引擎
│       ├── llm.js                # LLM 客户端
│       ├── database.js           # SQLite 本地缓存
│       └── formatters.js         # CLI 输出格式化
├── mcp-server/
│   ├── index.mjs                 # MCP Server 入口
│   └── tools/
│       ├── memo-tools.js         # 笔记透传工具
│       ├── tag-tools.js          # 标签透传工具
│       └── ai-tools.js           # AI 增强工具
├── prompts/                      # AI 提示词
├── src/
│   └── index.html                # Web UI
└── data/                         # 本地缓存（gitignored）
```

## 与 js-knowledge-collector 的关系

| 维度 | js-knowledge-collector | js-knowledge-flomo |
|------|------------------------|-------------------|
| 输入 | 外部 URL | 自己的 flomo 笔记 |
| 核心 | 抓取 + 总结 | 导入 + 加工 + 洞察 |
| 数据流 | 外部 → 本地 → flomo | flomo ↔ 本地 ↔ AI |
| 价值 | 把外部知识变成自己的 | 把碎片笔记变成结构化知识 |
