import nodePath from "node:path";
import nodeFs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = nodePath.resolve(__dirname, "..");
const SRC_DIR = nodePath.join(PROJECT_ROOT, "src");

const ROUTE_PREFIX = "/plugins/js-knowledge-flomo";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function applyEnv(pluginCfg) {
  if (pluginCfg.flomoToken) process.env.FLOMO_TOKEN = pluginCfg.flomoToken;
  if (pluginCfg.flomoMcpUrl) process.env.FLOMO_MCP_URL = pluginCfg.flomoMcpUrl;
  if (pluginCfg.llmApiBaseUrl) process.env.LLM_API_BASE_URL = pluginCfg.llmApiBaseUrl;
  if (pluginCfg.llmApiKey) process.env.LLM_API_KEY = pluginCfg.llmApiKey;
  if (pluginCfg.llmApiModel) process.env.LLM_API_MODEL = pluginCfg.llmApiModel;
  if (pluginCfg.dbPath) process.env.DB_PATH = pluginCfg.dbPath;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function jsonResult(data) {
  return textResult(JSON.stringify(data, null, 2));
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function serveStaticFile(res, filePath) {
  const ext = nodePath.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const stream = nodeFs.createReadStream(filePath);
  stream.on("error", () => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  res.writeHead(200, { "Content-Type": mime });
  stream.pipe(res);
}

async function getFlomoClient() {
  const FlomoMcpClient = (await import("../cli/lib/flomo-mcp-client.js")).default;
  return FlomoMcpClient.getInstance();
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function register(api) {
  dotenv.config({ path: nodePath.join(PROJECT_ROOT, ".env"), override: false });

  const pluginCfg = api.pluginConfig ?? {};
  applyEnv(pluginCfg);

  // =========================================================================
  // Tools: Memo (5)
  // =========================================================================

  api.registerTool(
    {
      name: "flomo_memo_create",
      label: "Flomo: Create Memo",
      description: "创建 flomo 笔记，支持标签和格式",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "笔记内容（可包含 #标签）" },
        },
        required: ["content"],
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.memoCreate(params.content);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`创建笔记失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_memo_update",
      label: "Flomo: Update Memo",
      description: "更新已有 flomo 笔记的内容",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "笔记 ID" },
          content: { type: "string", description: "新的笔记内容" },
        },
        required: ["id", "content"],
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.memoUpdate(params.id, params.content);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`更新笔记失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_memo_search",
      label: "Flomo: Search Memos",
      description:
        "搜索 flomo 笔记，支持关键词、标签、时间范围和语义搜索。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          tag: { type: "string", description: "按标签筛选" },
          from: { type: "string", description: "起始日期 (YYYY-MM-DD)" },
          to: { type: "string", description: "结束日期 (YYYY-MM-DD)" },
          limit: { type: "number", description: "返回数量" },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.memoSearch(params);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`搜索笔记失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_memo_batch_get",
      label: "Flomo: Batch Get Memos",
      description: "批量获取多条 flomo 笔记的完整内容",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "笔记 ID 列表",
          },
        },
        required: ["ids"],
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.memoBatchGet(params.ids);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`批量获取笔记失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_memo_recommended",
      label: "Flomo: Recommended Memos",
      description: "根据一条笔记找出内容相关的其他笔记",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "笔记 ID" },
        },
        required: ["id"],
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.memoRecommended(params.id);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`获取推荐笔记失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  // =========================================================================
  // Tools: Tags (3)
  // =========================================================================

  api.registerTool(
    {
      name: "flomo_tag_tree",
      label: "Flomo: Tag Tree",
      description: "获取 flomo 完整的标签层级结构",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const client = await getFlomoClient();
          const result = await client.tagTree();
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`获取标签树失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_tag_search",
      label: "Flomo: Search Tags",
      description: "按关键词搜索 flomo 标签",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },
        required: ["query"],
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.tagSearch(params.query);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`搜索标签失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_tag_rename",
      label: "Flomo: Rename Tag",
      description: "重命名 flomo 标签，所有关联笔记同步更新",
      parameters: {
        type: "object",
        properties: {
          old_name: { type: "string", description: "原标签名" },
          new_name: { type: "string", description: "新标签名" },
        },
        required: ["old_name", "new_name"],
      },
      async execute(_toolCallId, params) {
        try {
          const client = await getFlomoClient();
          const result = await client.tagRename(params.old_name, params.new_name);
          await client.disconnect();
          return jsonResult(result);
        } catch (err) {
          return textResult(`重命名标签失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  // =========================================================================
  // Tools: AI Enhanced (7)
  // =========================================================================

  api.registerTool(
    {
      name: "flomo_generate_insights",
      label: "Flomo: Generate Insights",
      description: "分析 flomo 笔记中的规律、反复主题和隐藏模式",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "限定标签范围" },
          period: { type: "number", description: "时间范围（天数）" },
          limit: { type: "number", description: "分析的笔记数量" },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const { generateInsights } = await import("../cli/lib/processor.js");
          const result = await generateInsights(params);
          return jsonResult(result);
        } catch (err) {
          return textResult(`生成洞察失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_track_evolution",
      label: "Flomo: Track Evolution",
      description: "追踪某个话题在 flomo 笔记中的观点演变过程",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "要追踪的话题" },
          limit: { type: "number", description: "笔记数量" },
        },
        required: ["topic"],
      },
      async execute(_toolCallId, params) {
        try {
          const { trackEvolution } = await import("../cli/lib/processor.js");
          const result = await trackEvolution(params.topic, { limit: params.limit });
          return jsonResult(result);
        } catch (err) {
          return textResult(`追踪演变失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_find_connections",
      label: "Flomo: Find Connections",
      description: "发现 flomo 笔记之间跨标签、跨时间的隐藏关联",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "限定标签范围" },
          limit: { type: "number", description: "笔记数量" },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const { findConnections } = await import("../cli/lib/processor.js");
          const result = await findConnections(params);
          return jsonResult(result);
        } catch (err) {
          return textResult(`关联发现失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_draft_outline",
      label: "Flomo: Draft Outline",
      description: "根据 flomo 笔记素材生成写作大纲",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "写作主题" },
        },
        required: ["topic"],
      },
      async execute(_toolCallId, params) {
        try {
          const { draftOutline } = await import("../cli/lib/processor.js");
          const result = await draftOutline(params.topic);
          return jsonResult(result);
        } catch (err) {
          return textResult(`生成大纲失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_collect_material",
      label: "Flomo: Collect Material",
      description: "搜集某主题相关的 flomo 笔记素材（含关联推荐）",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "主题关键词" },
        },
        required: ["topic"],
      },
      async execute(_toolCallId, params) {
        try {
          const { collectMaterial } = await import("../cli/lib/processor.js");
          const result = await collectMaterial(params.topic);
          return jsonResult(result);
        } catch (err) {
          return textResult(`搜集素材失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_suggest_tags",
      label: "Flomo: Suggest Tags",
      description: "AI 为无标签的 flomo 笔记建议合适的标签",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "处理笔记数量" },
        },
      },
      async execute(_toolCallId, params) {
        try {
          const { suggestTags } = await import("../cli/lib/processor.js");
          const result = await suggestTags({ limit: params.limit });
          return jsonResult(result);
        } catch (err) {
          return textResult(`标签建议失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "flomo_audit_tags",
      label: "Flomo: Audit Tags",
      description: "分析 flomo 标签体系，给出优化建议（重复/命名/层级问题）",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const { auditTags } = await import("../cli/lib/processor.js");
          const result = await auditTags();
          return jsonResult(result);
        } catch (err) {
          return textResult(`标签审计失败: ${err.message}`);
        }
      },
    },
    { optional: true },
  );

  // =========================================================================
  // Gateway HTTP Routes: Web UI + REST API
  // =========================================================================

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}`,
    auth: "plugin",
    async handler(req, res) {
      res.writeHead(301, { Location: `${ROUTE_PREFIX}/` });
      res.end();
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/`,
    auth: "plugin",
    async handler(req, res) {
      serveStaticFile(res, nodePath.join(SRC_DIR, "index.html"));
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/search`,
    auth: "plugin",
    async handler(req, res) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      try {
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const query = parsed.searchParams.get("q") || "";
        const tag = parsed.searchParams.get("tag") || "";
        const limit = parseInt(parsed.searchParams.get("limit") || "20", 10);
        const client = await getFlomoClient();
        const result = await client.memoSearch({
          query: query || undefined,
          tag: tag || undefined,
          limit,
        });
        await client.disconnect();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/tags`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const client = await getFlomoClient();
        const result = await client.tagTree();
        await client.disconnect();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/insights`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const tag = parsed.searchParams.get("tag") || "";
        const period = parsed.searchParams.get("period") || "";
        const { generateInsights } = await import("../cli/lib/processor.js");
        const result = await generateInsights({
          tag: tag || undefined,
          period: period || undefined,
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/stats`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const { getStats } = await import("../cli/lib/database.js");
        const result = await getStats();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/api/cached-insights`,
    auth: "plugin",
    async handler(req, res) {
      try {
        const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const type = parsed.searchParams.get("type") || "";
        const { getInsights } = await import("../cli/lib/database.js");
        const result = await getInsights({ type: type || undefined });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    },
  });

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/{filePath}`,
    auth: "plugin",
    async handler(req, res) {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const subPath = decodeURIComponent(
        parsed.pathname.slice(ROUTE_PREFIX.length + 1),
      );

      if (subPath.startsWith("api/")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const filePath = nodePath.normalize(nodePath.join(SRC_DIR, subPath));
      if (!filePath.startsWith(SRC_DIR)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      if (!nodeFs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      serveStaticFile(res, filePath);
    },
  });

  // =========================================================================
  // CLI: openclaw flomo {auth|search|write|tags|insights|stats}
  // =========================================================================

  api.registerCli(
    ({ program }) => {
      const flomo = program
        .command("flomo")
        .description("JS Knowledge Flomo — 以 flomo 为核心的知识管理工具");

      flomo
        .command("auth")
        .description("执行 flomo OAuth 授权")
        .option("--force", "强制重新授权")
        .option("--logout", "清除本地认证信息")
        .action(async (opts) => {
          try {
            const { getAccessToken, clearAuth } = await import("../cli/lib/auth.js");
            if (opts.logout) {
              await clearAuth();
              console.log("已清除本地认证信息");
              return;
            }
            if (process.env.FLOMO_TOKEN) {
              console.log("当前使用环境变量 FLOMO_TOKEN 直接认证，无需 OAuth 授权。");
              return;
            }
            await getAccessToken({ force: !!opts.force });
            console.log("认证成功");
          } catch (err) {
            console.error(`认证失败: ${err.message}`);
          }
        });

      flomo
        .command("search <query>")
        .description("搜索 flomo 笔记")
        .option("--tag <tag>", "按标签筛选")
        .option("--from <date>", "起始日期 (YYYY-MM-DD)")
        .option("--to <date>", "结束日期 (YYYY-MM-DD)")
        .option("--limit <n>", "返回数量")
        .action(async (query, opts) => {
          try {
            const client = await getFlomoClient();
            const result = await client.memoSearch({
              query,
              tag: opts.tag,
              from: opts.from,
              to: opts.to,
              limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
            });
            await client.disconnect();
            console.log(JSON.stringify(result, null, 2));
          } catch (err) {
            console.error(`搜索失败: ${err.message}`);
          }
        });

      flomo
        .command("write <text>")
        .description("写入笔记到 flomo")
        .option("--tag <tags>", "逗号分隔的标签")
        .action(async (text, opts) => {
          try {
            let content = text;
            if (opts.tag) {
              const tags = opts.tag
                .split(",")
                .map((t) => (t.trim().startsWith("#") ? t.trim() : `#${t.trim()}`));
              content = tags.join(" ") + "\n" + content;
            }
            const client = await getFlomoClient();
            const result = await client.memoCreate(content);
            await client.disconnect();
            console.log(JSON.stringify(result, null, 2));
          } catch (err) {
            console.error(`写入失败: ${err.message}`);
          }
        });

      flomo
        .command("tags")
        .description("查看 flomo 标签树")
        .action(async () => {
          try {
            const client = await getFlomoClient();
            const result = await client.tagTree();
            await client.disconnect();
            console.log(JSON.stringify(result, null, 2));
          } catch (err) {
            console.error(`获取标签失败: ${err.message}`);
          }
        });

      flomo
        .command("insights")
        .description("AI 分析笔记规律")
        .option("--tag <tag>", "限定标签范围")
        .option("--period <days>", "时间范围（天）")
        .option("--limit <n>", "分析的笔记数量")
        .action(async (opts) => {
          try {
            const { generateInsights } = await import("../cli/lib/processor.js");
            const result = await generateInsights({
              tag: opts.tag,
              period: opts.period,
              limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
            });
            console.log(JSON.stringify(result, null, 2));
          } catch (err) {
            console.error(`洞察失败: ${err.message}`);
          }
        });

      flomo
        .command("stats")
        .description("查看本地缓存统计")
        .action(async () => {
          try {
            const { getStats } = await import("../cli/lib/database.js");
            const stats = await getStats();
            console.log("\n=== 本地缓存统计 ===");
            console.log(`  缓存笔记: ${stats.cached_memos || 0}`);
            console.log(`  洞察报告: ${stats.insights || 0}`);
            if (stats.latest_memo_cache) console.log(`  最近缓存: ${stats.latest_memo_cache}`);
            if (stats.latest_insight) console.log(`  最近洞察: ${stats.latest_insight}`);
            console.log("");
          } catch (err) {
            console.error(`查询失败: ${err.message}`);
          }
        });
    },
    { commands: ["flomo"] },
  );
}
