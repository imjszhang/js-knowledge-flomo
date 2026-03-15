---
name: js-knowledge-flomo
description: Flomo-centric knowledge management — read/write flomo memos via MCP, AI-powered insights, tag analysis, connection discovery, and writing assistance.
version: 1.0.0
metadata:
  openclaw:
    emoji: "\U0001F4DD"
    homepage: https://github.com/user/js-knowledge-flomo
    os:
      - windows
      - macos
      - linux
    requires:
      bins:
        - node
---

# JS Knowledge Flomo

以 flomo 为核心的知识管理工具 — 通过 flomo MCP 读写笔记，叠加 AI 洞察、关联发现、标签整理、写作辅助等增强能力。

## First Step: Detect Runtime Mode

Before performing any operation, detect which of the **three runtime modes** is active. The result determines command prefixes, available features, and configuration sources.

### Detection Steps

#### Step 0 — OS & Environment Variable Probe

First detect the current operating system to choose the correct shell commands, then check OpenClaw-related environment variables:

**OS Detection:**

| Check | Windows | macOS / Linux |
|-------|---------|---------------|
| OS identification | `echo %OS%` or `$env:OS` (PowerShell) | `uname -s` |
| Home directory | `%USERPROFILE%` | `$HOME` |
| Default OpenClaw state dir | `%USERPROFILE%\.openclaw\` | `~/.openclaw/` |
| Default config path | `%USERPROFILE%\.openclaw\openclaw.json` | `~/.openclaw/openclaw.json` |

**Environment Variable Check:**

```bash
# Windows (PowerShell)
Get-ChildItem Env: | Where-Object { $_.Name -match '^OPENCLAW_' }

# Windows (CMD / Git Bash)
set | grep -iE "^OPENCLAW_"

# macOS / Linux
env | grep -iE "^OPENCLAW_"
```

| Variable | Meaning if set |
|----------|---------------|
| `OPENCLAW_CONFIG_PATH` | Direct path to config file — **highest priority**, use as-is |
| `OPENCLAW_STATE_DIR` | OpenClaw state directory — config file at `$OPENCLAW_STATE_DIR/openclaw.json` |
| `OPENCLAW_HOME` | Custom home directory — state dir resolves to `$OPENCLAW_HOME/.openclaw/` |

**OpenClaw config file resolution order** (first match wins):

1. `OPENCLAW_CONFIG_PATH` is set → use that file directly
2. `OPENCLAW_STATE_DIR` is set → `$OPENCLAW_STATE_DIR/openclaw.json`
3. `OPENCLAW_HOME` is set → `$OPENCLAW_HOME/.openclaw/openclaw.json`
4. None set → default `~/.openclaw/openclaw.json` (Windows: `%USERPROFILE%\.openclaw\openclaw.json`)

Use the resolved config path in all subsequent steps.

#### Step 1 — OpenClaw Binary Detection

1. Check if `openclaw` command exists on PATH (Windows: `where openclaw`, macOS/Linux: `which openclaw`)
2. If exists, read the OpenClaw config file (path resolved by Step 0) and look for `js-knowledge-flomo` in `plugins.entries` with `enabled: true`
3. Verify that `plugins.load.paths` contains a path pointing to this project's `openclaw-plugin/` directory

If **all three checks pass** → use **OpenClaw Plugin Mode**. Otherwise → use **Standalone Mode** (CLI or MCP Server).

### Mode Comparison

| Aspect | OpenClaw Plugin Mode | Standalone CLI Mode | MCP Server Mode |
|--------|---------------------|-------------------|----------------|
| Configuration | `~/.openclaw/openclaw.json` → `plugins.entries.js-knowledge-flomo.config` | `.env` file | `.env` file or `env` in MCP config |
| Command prefix | `openclaw flomo <cmd>` | `node cli/cli.js <cmd>` | N/A (tool calls) |
| AI tools | `flomo_*` (15 tools via OpenClaw Agent) | Not available (use CLI) | `memo_*` / `tag_*` / `generate_*` etc. (via MCP protocol) |
| Web UI | `http://<host>/plugins/js-knowledge-flomo/` | `http://localhost:3000` (via `serve`) | Not available |
| OAuth auth | `openclaw flomo auth` | `node cli/cli.js auth` | Auto on first tool call |
| Caller | OpenClaw Agent | Terminal user | Cursor / Claude Desktop |

### OpenClaw Plugin Mode

When the plugin is deployed:

- **CLI**: always use `openclaw flomo ...` instead of `node cli/cli.js ...`
- **AI tools**: prefer `flomo_*` tools when invoked from an OpenClaw Agent session
- **Config**: modify `~/.openclaw/openclaw.json` for LLM endpoints and model; do NOT edit `.env` for plugin-managed settings
- **Auth**: run `openclaw flomo auth` once to complete OAuth; subsequent calls auto-refresh tokens
- **Web UI**: access at `http://<openclaw-host>/plugins/js-knowledge-flomo/`

### Standalone CLI Mode

When running without OpenClaw:

- **CLI**: use `node cli/cli.js <cmd>`
- **Config**: `.env` for all settings (see environment variable table below)
- **Auth**: `node cli/cli.js auth`
- **Web UI**: `node cli/cli.js serve` then open `http://localhost:3000`

### MCP Server Mode

When used as MCP Server for Cursor / Claude Desktop:

- **Start**: `node mcp-server/index.mjs` (stdio) or `node mcp-server/index.mjs --http --port 8080`
- **Config**: environment variables passed via MCP client config (e.g. `.cursor/mcp.json`)
- **Auth**: automatic on first tool call — browser opens for OAuth if no saved token

---

## Deployment Probe

After detecting the runtime mode, run the following diagnostic steps to build a complete picture of the local deployment. Execute these in order; skip remaining steps if an earlier step indicates OpenClaw is unavailable.

> **Prerequisite**: Step 0 (OS & Environment Variable Probe) from the Detection Steps above must have already been executed. Use the detected OS to choose correct commands, and use the resolved config path from Step 0.

### Step 1 — OpenClaw Availability

- Windows: `where openclaw` / macOS & Linux: `which openclaw`
- If found: `openclaw --version` to confirm the installed version

### Step 2 — Plugin Load Status

Read the OpenClaw config file (path resolved by Step 0) and check:

- `plugins.load.paths` — does it include a path pointing to this project's `openclaw-plugin/` directory?
- `plugins.entries["js-knowledge-flomo"].enabled` — is the plugin enabled?
- `plugins.entries["js-knowledge-flomo"].config` — extract `llmApiBaseUrl`, `llmApiModel` for a quick config snapshot

### Step 3 — OAuth Token Status

Check if `~/.flomo-auth.json` exists and contains a valid `access_token`:

```bash
# Windows (PowerShell)
Test-Path "$env:USERPROFILE\.flomo-auth.json"

# macOS / Linux
test -f ~/.flomo-auth.json && echo "exists" || echo "missing"
```

If missing or expired → remind user to run `openclaw flomo auth` (or `node cli/cli.js auth`).

### Step 4 — LLM API Connectivity

Verify the configured LLM API is reachable (required for AI tools):

- Check `llmApiBaseUrl` and `llmApiKey` are set (via plugin config or `.env`)
- AI tools (`flomo_generate_insights`, etc.) will fail without a working LLM endpoint

### Step 5 — Local Cache Health

Check if `data/cache.db` (or custom `DB_PATH`) exists:

- Present → local caching active
- Missing → will be auto-created on first use; not an error

---

## Config Files Map

| File | Typical Path | Purpose | How to Modify |
|------|-------------|---------|--------------|
| `openclaw.json` | `~/.openclaw/openclaw.json` | Plugin config: LLM endpoint, model, flomo MCP URL | Edit JSON directly |
| `.env` | `{projectRoot}/` | Standalone config: all environment variables | Edit file directly |
| `.env.example` | `{projectRoot}/` | Template for `.env` | Copy to `.env` and fill in |
| `.flomo-auth.json` | `~/` | OAuth token storage (auto-managed) | Do NOT edit by hand; use `auth` command |
| `cache.db` | `{projectRoot}/data/` or custom `DB_PATH` | Local SQLite cache for memos and insights | Auto-managed; safe to delete (rebuilds on use) |

---

## Action Priority

When performing an operation, always prefer the highest-priority method available:

> **OpenClaw AI Tool → OpenClaw CLI (`openclaw flomo ...`) → Standalone CLI (`node cli/cli.js ...`) → MCP Server tool call**

| Scenario | Preferred | Fallback | Last Resort |
|----------|-----------|----------|-------------|
| Search memos | `flomo_memo_search` | `openclaw flomo search` | `node cli/cli.js search` |
| Create memo | `flomo_memo_create` | `openclaw flomo write` | `node cli/cli.js write` |
| View tags | `flomo_tag_tree` | `openclaw flomo tags` | `node cli/cli.js tags` |
| Generate insights | `flomo_generate_insights` | `openclaw flomo insights` | `node cli/cli.js insights` |
| Track evolution | `flomo_track_evolution` | N/A | `node cli/cli.js evolution` |
| Find connections | `flomo_find_connections` | N/A | `node cli/cli.js connections` |
| Draft outline | `flomo_draft_outline` | N/A | `node cli/cli.js outline` |
| Collect material | `flomo_collect_material` | N/A | `node cli/cli.js material` |
| Suggest tags | `flomo_suggest_tags` | N/A | `node cli/cli.js suggest-tags` |
| Audit tags | `flomo_audit_tags` | N/A | `node cli/cli.js tag-audit` |
| OAuth auth | `openclaw flomo auth` | `node cli/cli.js auth` | N/A |
| View stats | `openclaw flomo stats` | `node cli/cli.js stats` | N/A |
| Change LLM config | edit `~/.openclaw/openclaw.json` plugin config | edit `.env` | N/A |

---

## Runbook

### "First time setup"

1. `openclaw flomo auth` — complete OAuth in browser (token saved to `~/.flomo-auth.json`)
2. Verify: any `flomo_memo_search` call should return results
3. For AI features: ensure `llmApiBaseUrl` and `llmApiKey` are configured in plugin config

### "Search my flomo notes about X"

1. `flomo_memo_search` with `query: "X"`
2. Optionally filter by `tag`, `from`, `to` date range
3. For full content of specific memos: `flomo_memo_batch_get` with the returned IDs

### "Generate weekly review"

1. `flomo_generate_insights` with `period: 7`
2. Review the analysis; use `flomo_memo_search` to drill into specific themes
3. `flomo_memo_create` to write the review summary back to flomo (tag with `#回顾`)

### "Help me write about a topic"

1. `flomo_collect_material` with `topic: "your topic"` — gather related memos
2. `flomo_find_connections` — discover hidden links between memos
3. `flomo_draft_outline` with `topic: "your topic"` — generate structured outline
4. Expand based on the outline

### "Clean up my tags"

1. `flomo_audit_tags` — get diagnosis of tag system issues
2. `flomo_tag_rename` for each rename/merge suggested
3. `flomo_suggest_tags` — batch-assign tags to untagged memos

### "Token expired / auth error"

1. `openclaw flomo auth --force` — force re-authorization
2. If persistent: `openclaw flomo auth --logout` then `openclaw flomo auth` — clear and redo

### "Switch LLM model / endpoint"

1. Edit `~/.openclaw/openclaw.json` → `plugins.entries["js-knowledge-flomo"].config` (change `llmApiBaseUrl`, `llmApiModel`, or `llmApiKey`)
2. No restart needed — next tool call picks up the new config automatically
3. Standalone mode: edit `.env` file

---

## What it does

JS Knowledge Flomo bridges your flomo notes with AI analysis capabilities:

1. **Memo Operations** — create, update, search, batch-get, and find related memos via flomo's official MCP Server
2. **Tag Management** — browse, search, and rename tags across your entire flomo account
3. **AI Insights** — discover patterns, track opinion evolution, find hidden connections
4. **Writing Assistance** — collect material and generate outlines from your memo archive
5. **Tag Optimization** — AI-powered tag suggestions and tag system audit

## Architecture

```
Cursor/Claude ─── MCP ──→ [js-knowledge-flomo MCP Server]
                                    │
                                    ├── 透传 → [flomo MCP Server] → flomo 笔记
                                    │
                                    └── AI 加工 → [LLM API] → 洞察/标签/大纲

OpenClaw Agent ─── tools ──→ [openclaw-plugin/index.mjs]
                                    │
                                    ├── flomo_memo_* → FlomoMcpClient → flomo MCP
                                    │
                                    └── flomo_*_insights/tags/... → processor.js → LLM
```

The OpenClaw plugin and MCP Server share the same core logic in `cli/lib/`.

## Provided AI Tools

### Memo Tools (5)

| Tool | Description |
|------|-------------|
| `flomo_memo_create` | Create a flomo memo (supports #tags) |
| `flomo_memo_update` | Update an existing memo |
| `flomo_memo_search` | Search memos by keyword, tag, date range |
| `flomo_memo_batch_get` | Batch-get multiple memos by ID |
| `flomo_memo_recommended` | Find related memos for a given memo |

### Tag Tools (3)

| Tool | Description |
|------|-------------|
| `flomo_tag_tree` | Get complete tag hierarchy |
| `flomo_tag_search` | Search tags by keyword |
| `flomo_tag_rename` | Rename a tag (all linked memos update) |

### AI Enhancement Tools (7)

| Tool | Description |
|------|-------------|
| `flomo_generate_insights` | Analyze patterns, recurring themes, hidden modes in memos |
| `flomo_track_evolution` | Track how opinions on a topic evolved over time |
| `flomo_find_connections` | Discover cross-tag, cross-time hidden connections |
| `flomo_draft_outline` | Generate a writing outline from memo material |
| `flomo_collect_material` | Collect topic-related memos (with recommendations) |
| `flomo_suggest_tags` | AI-suggest tags for untagged memos |
| `flomo_audit_tags` | Analyze tag system issues and suggest improvements |

## CLI Commands

### OpenClaw Plugin Mode

```
openclaw flomo auth [--force] [--logout]    OAuth authorization
openclaw flomo search <query>               Search memos
  --tag <tag>    --from <date>    --to <date>    --limit <n>
openclaw flomo write <text>                 Create memo
  --tag <tags>                                (comma-separated)
openclaw flomo tags                         View tag tree
openclaw flomo insights                     AI insights
  --tag <tag>    --period <days>    --limit <n>
openclaw flomo stats                        Local cache statistics
```

### Standalone CLI Mode

```
node cli/cli.js auth [--force] [--logout]
node cli/cli.js write <text> [--tag <tags>]
node cli/cli.js update <id> <text>
node cli/cli.js search <query> [--tag] [--from] [--to] [--limit]
node cli/cli.js get <id...>
node cli/cli.js related <id>
node cli/cli.js tags
node cli/cli.js tag-search <query>
node cli/cli.js tag-rename <old> <new>
node cli/cli.js insights [--tag] [--period] [--limit]
node cli/cli.js evolution <topic>
node cli/cli.js connections [--tag]
node cli/cli.js outline <topic>
node cli/cli.js material <topic>
node cli/cli.js suggest-tags [--limit]
node cli/cli.js tag-audit
node cli/cli.js serve [--port]
node cli/cli.js stats
```

## Web UI

The plugin registers HTTP routes on the OpenClaw gateway:

| Route | Description |
|-------|-------------|
| `/plugins/js-knowledge-flomo/` | Web UI — memo search, tag tree, AI insights, statistics |
| `/plugins/js-knowledge-flomo/api/search` | JSON API — search memos |
| `/plugins/js-knowledge-flomo/api/tags` | JSON API — tag tree |
| `/plugins/js-knowledge-flomo/api/insights` | JSON API — generate AI insights |
| `/plugins/js-knowledge-flomo/api/stats` | JSON API — local cache statistics |
| `/plugins/js-knowledge-flomo/api/cached-insights` | JSON API — previously generated insights |

In standalone mode, start with `node cli/cli.js serve` and access at `http://localhost:3000`.

## Skill Bundle Structure

```
js-knowledge-flomo/
├── SKILL.md                           ← Skill entry point (this file)
├── package.json                       ← Root package
├── .env.example                       ← Environment variable template
├── openclaw-plugin/
│   ├── openclaw.plugin.json           ← Plugin manifest (config schema, UI hints)
│   ├── package.json                   ← ESM module descriptor
│   ├── index.mjs                      ← Plugin logic — 15 AI tools + CLI + HTTP routes
│   └── skills/
│       └── flomo-assistant/
│           └── SKILL.md               ← Knowledge management workflow guide
├── cli/
│   ├── cli.js                         ← CLI entry point
│   └── lib/
│       ├── flomo-mcp-client.js        ← flomo MCP Client (Streamable HTTP + OAuth)
│       ├── auth.js                    ← OAuth 2.0 + PKCE authorization
│       ├── processor.js               ← AI knowledge processing engine
│       ├── llm.js                     ← LLM client (OpenAI-compatible)
│       ├── database.js                ← SQLite local cache
│       ├── server.js                  ← HTTP server (Web UI + REST API)
│       └── formatters.js              ← CLI output formatting
├── mcp-server/
│   ├── index.mjs                      ← MCP Server entry (stdio / HTTP)
│   └── tools/
│       ├── memo-tools.js              ← Memo pass-through tools
│       ├── tag-tools.js               ← Tag pass-through tools
│       └── ai-tools.js                ← AI enhancement tools
├── prompts/                           ← AI prompt templates
│   ├── insight.txt
│   ├── outline.txt
│   ├── relate.txt
│   ├── tag-suggest.txt
│   └── digest.txt
├── src/
│   └── index.html                     ← Web UI (single page)
└── data/                              ← Local cache (gitignored)
```

> `openclaw-plugin/index.mjs` imports from `../cli/lib/` via relative paths, so the directory layout must be preserved.

## Prerequisites

- **Node.js** >= 18
- A **flomo** account (for OAuth authorization)
- An **OpenAI-compatible API** endpoint (for AI features; memo/tag operations work without it)

## Install

### Register the plugin

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/js-knowledge-flomo/openclaw-plugin"]
    },
    "entries": {
      "js-knowledge-flomo": {
        "enabled": true,
        "config": {
          "llmApiBaseUrl": "http://localhost:8888/v1",
          "llmApiModel": "your-model",
          "llmApiKey": "your-key"
        }
      }
    }
  }
}
```

Then authorize flomo:

```bash
openclaw flomo auth
```

### Standalone (without OpenClaw)

```bash
cp .env.example .env
# Edit .env with your LLM API credentials
node cli/cli.js auth
```

### MCP Server (for Cursor)

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "js-knowledge-flomo": {
      "command": "node",
      "args": ["/path/to/js-knowledge-flomo/mcp-server/index.mjs"],
      "env": {
        "FLOMO_MCP_URL": "https://flomoapp.com/mcp",
        "LLM_API_BASE_URL": "your-api-url",
        "LLM_API_KEY": "your-key",
        "LLM_API_MODEL": "gpt-4.1-mini"
      }
    }
  }
}
```

## Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `flomoMcpUrl` | string | `https://flomoapp.com/mcp` | flomo MCP server URL |
| `llmApiBaseUrl` | string | — | OpenAI-compatible API endpoint |
| `llmApiKey` | string | — | API key (secret) |
| `llmApiModel` | string | `gpt-4.1-mini` | LLM model name |
| `dbPath` | string | `data/cache.db` | Local SQLite cache path |

## Environment Variables (standalone / MCP Server)

| Variable | Description | Default |
|----------|-------------|---------|
| `FLOMO_MCP_URL` | flomo MCP server URL | `https://flomoapp.com/mcp` |
| `LLM_API_BASE_URL` | LLM API base URL | — |
| `LLM_API_KEY` | LLM API key | — |
| `LLM_API_MODEL` | Model name | `gpt-4.1-mini` |
| `DB_PATH` | Local cache database path | `./data/cache.db` |

## Verify

```bash
openclaw flomo stats
```

Or in standalone mode:

```bash
node cli/cli.js stats
```

Expected output:

```
=== 本地缓存统计 ===
  缓存笔记: 42
  洞察报告: 3
  最近缓存: 2026-03-15
  最近洞察: 2026-03-14
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `OAuth 授权超时` | Browser didn't complete auth in 3 min | Re-run `openclaw flomo auth`; ensure browser can reach `flomoapp.com` |
| `MCP Client 未连接` | Token expired or missing | Run `openclaw flomo auth --force` |
| `Token 交换失败` | Network issue or flomo server down | Check internet; retry later |
| AI tools return errors | LLM API not configured | Set `llmApiBaseUrl` and `llmApiKey` in plugin config or `.env` |
| `搜索笔记失败` | Not authorized | Run `openclaw flomo auth` first |
| Tools not appearing in OpenClaw | Plugin path wrong | Ensure path points to `openclaw-plugin/` subdirectory |
| Web UI shows "加载失败" | Server not running or auth expired | Check auth status; restart if needed |

## Security

- OAuth tokens are stored locally at `~/.flomo-auth.json` — never committed to version control
- The plugin communicates only with **user-configured** endpoints: flomo MCP Server and LLM API
- No telemetry, no external data collection
- All AI processing happens through the user's own LLM API endpoint
- Write operations (`memo_create`, `memo_update`, `tag_rename`) directly affect the user's flomo account

## Links

- flomo MCP: https://flomoapp.com/mcp
- License: MIT
