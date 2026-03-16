# js-knowledge-flomo

**以 flomo 为核心的知识管理工具** — 通过 MCP 读写笔记，用 AI 做洞察、关联发现、标签整理与写作辅助。

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 为什么用这个项目？

- **打通 flomo**：用 [flomo 官方 MCP](https://flomoapp.com/mcp) 做 OAuth 授权，安全读写你的笔记。
- **AI 增强**：在笔记基础上做「洞察报告」「观点演变」「关联发现」「写作大纲」「标签建议」等，全部走你自建的 OpenAI 兼容 API，数据不出你的环境。
- **多种用法**：可当 **OpenClaw 插件**、**独立 CLI**、**MCP Server**（Cursor / Claude Desktop），也可跑本地 **Web UI** 查笔记、看标签、生成洞察。
- **本地优先**：OAuth 凭据与本地缓存都在本机，无上报、无埋点。

---

## 功能一览

| 能力 | 说明 |
|------|------|
| 笔记读写 | 搜索、创建、更新笔记；按标签、时间筛选 |
| 标签管理 | 标签树、标签搜索、重命名；AI 标签建议与体系审计 |
| AI 洞察 | 从笔记中归纳模式、主题与隐藏结构 |
| 观点演变 | 按主题追踪想法随时间的演变 |
| 关联发现 | 跨标签、跨时间发现笔记间的联系 |
| 写作辅助 | 根据主题生成大纲、搜集相关素材 |
| Web UI | 本地页面：搜索、标签树、洞察生成、统计 |

---

## 快速开始

### 环境要求

- **Node.js** ≥ 18  
- **flomo 账号**（用于 OAuth）  
- **OpenAI 兼容 API**（仅 AI 功能需要；纯笔记/标签操作可不配）

### 1. 安装依赖

```bash
git clone https://github.com/imjszhang/js-knowledge-flomo.git
cd js-knowledge-flomo
npm install
```

### 2. 配置环境

```bash
cp .env.example .env
```

编辑 `.env`，至少填写（AI 功能需要）：

- `LLM_API_BASE_URL` — 你的 API 地址（如 `https://api.openai.com/v1`）
- `LLM_API_KEY` — API 密钥  
- `LLM_API_MODEL` — 模型名（如 `gpt-4.1-mini`）

### 3. 完成 flomo 授权

```bash
node cli/cli.js auth
```

按提示在浏览器中完成 OAuth，授权信息会保存在本机 `~/.flomo-auth.json`。

### 4. 试几条命令

```bash
# 搜索笔记
node cli/cli.js search "关键词" --tag 某标签 --limit 10

# 写一条笔记
node cli/cli.js write "今天学到的东西" --tag 学习

# 看标签树
node cli/cli.js tags

# 生成 AI 洞察（需先配置 LLM）
node cli/cli.js insights --tag 读书 --period 30
```

### 5. 启动 Web UI（可选）

```bash
npm run dev
# 或：node cli/cli.js serve
```

浏览器打开 **http://127.0.0.1:3000**，可搜索笔记、看标签、生成洞察、查看本地统计。

---

## 三种使用方式

| 方式 | 适用场景 | 入口 |
|------|----------|------|
| **OpenClaw 插件** | 在 OpenClaw 里用 Agent + 15 个 flomo 工具 | `openclaw flomo <命令>` |
| **独立 CLI** | 终端直接操作 flomo | `node cli/cli.js <命令>` |
| **MCP Server** | 在 Cursor / Claude Desktop 里当 MCP 工具用 | 配置 MCP 后由 IDE 调用 |

### 独立 CLI 常用命令

```bash
node cli/cli.js auth              # 授权 / 登出用 --logout
node cli/cli.js search <关键词>   # 搜索笔记 [--tag] [--from] [--to] [--limit]
node cli/cli.js write <内容>      # 写笔记 [--tag 标签1,标签2]
node cli/cli.js update <id> <内容>
node cli/cli.js tags              # 标签树
node cli/cli.js insights          # AI 洞察 [--tag] [--period]
node cli/cli.js evolution <主题>  # 观点演变
node cli/cli.js connections       # 关联发现 [--tag]
node cli/cli.js outline <主题>    # 写作大纲
node cli/cli.js material <主题>   # 搜集素材
node cli/cli.js suggest-tags      # AI 标签建议
node cli/cli.js tag-audit        # 标签体系审计
node cli/cli.js serve [--port]   # 启动 Web UI
node cli/cli.js stats            # 本地缓存统计
```

### 在 Cursor 里用 MCP

在 Cursor 的 MCP 配置（如 `.cursor/mcp.json`）里添加：

```json
{
  "mcpServers": {
    "js-knowledge-flomo": {
      "command": "node",
      "args": ["/你的路径/js-knowledge-flomo/mcp-server/index.mjs"],
      "env": {
        "FLOMO_MCP_URL": "https://flomoapp.com/mcp",
        "LLM_API_BASE_URL": "你的API地址",
        "LLM_API_KEY": "你的Key",
        "LLM_API_MODEL": "gpt-4.1-mini"
      }
    }
  }
}
```

首次使用某工具时会自动拉起浏览器做 flomo OAuth。

---

## 配置说明

### 环境变量（独立 CLI / MCP）

| 变量 | 说明 | 默认 |
|------|------|------|
| `FLOMO_MCP_URL` | flomo MCP 地址 | `https://flomoapp.com/mcp` |
| `LLM_API_BASE_URL` | LLM API 根地址 | — |
| `LLM_API_KEY` | LLM API 密钥 | — |
| `LLM_API_MODEL` | 模型名 | `gpt-4.1-mini` |
| `DB_PATH` | 本地缓存库路径 | `./data/cache.db` |

### OpenClaw 插件配置

在 `~/.openclaw/openclaw.json` 的 `plugins.entries["js-knowledge-flomo"].config` 中配置 `llmApiBaseUrl`、`llmApiKey`、`llmApiModel` 等，详见项目内 [SKILL.md](SKILL.md)。

---

## 项目结构（简要）

```
js-knowledge-flomo/
├── cli/              # 命令行入口与核心逻辑
│   ├── cli.js        # CLI 入口
│   └── lib/          # flomo 客户端、OAuth、LLM、本地缓存、Web 服务
├── mcp-server/       # MCP 服务（stdio / HTTP）
├── openclaw-plugin/  # OpenClaw 插件（15 个 AI 工具 + 路由）
├── prompts/         # AI 提示词模板
├── src/              # Web UI 静态资源
├── .env.example      # 环境变量示例
└── SKILL.md          # 详细技能说明与排错
```

---

## 常见问题

| 现象 | 处理 |
|------|------|
| OAuth 授权超时 | 3 分钟内完成浏览器授权；确认能访问 flomoapp.com |
| Token 失效 / 未连接 | 执行 `node cli/cli.js auth --force` 重新授权 |
| AI 相关报错 | 检查 `.env` 或插件配置里的 `LLM_API_*` 是否填对且可访问 |
| Web 页面加载失败 | 先执行一次 `auth`，再 `serve`，并确认端口没被占用 |

更多细节与排错见 [SKILL.md](SKILL.md)。

---

## 安全与隐私

- OAuth 凭据仅存于本机 `~/.flomo-auth.json`，不提交到仓库。
- 仅连接你配置的 **flomo MCP** 与 **LLM API**，无遥测、无数据上报。
- AI 推理全部走你自己的 API，笔记与洞察数据不经过第三方服务。
- Web 服务默认只监听 `127.0.0.1`，不对外网开放。

---

## 许可证与链接

- **许可证**：MIT  
- **flomo MCP**：<https://flomoapp.com/mcp>  
- 问题与建议欢迎提 [Issue](https://github.com/imjszhang/js-knowledge-flomo/issues)。

如果这个项目对你有用，欢迎 Star 或推荐给同样用 flomo 的朋友。
