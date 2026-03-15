#!/usr/bin/env node

/**
 * js-knowledge-flomo MCP Server
 *
 * 双模式启动：
 *   - stdio（默认）：供 Cursor / Claude Desktop 通过 subprocess 调用
 *   - HTTP：供远程 MCP 客户端连接（--http --port 8080）
 *
 * 暴露两类工具：
 *   1. 透传工具 — 直接转发 flomo MCP 的原生能力
 *   2. AI 增强工具 — 在 flomo 数据基础上叠加 AI 分析
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMemoTools } from './tools/memo-tools.js';
import { registerTagTools } from './tools/tag-tools.js';
import { registerAiTools } from './tools/ai-tools.js';

const server = new McpServer({
    name: 'js-knowledge-flomo',
    version: '1.0.0',
});

registerMemoTools(server);
registerTagTools(server);
registerAiTools(server);

// ── 启动 ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const useHttp = args.includes('--http');

if (useHttp) {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 8080;

    const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const http = await import('node:http');

    const httpServer = http.createServer(async (req, res) => {
        if (req.url === '/mcp') {
            const transport = new StreamableHTTPServerTransport('/mcp');
            await server.connect(transport);
            await transport.handleRequest(req, res);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    httpServer.listen(port, () => {
        process.stderr.write(`MCP Server (HTTP) listening on http://localhost:${port}/mcp\n`);
    });
} else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('MCP Server (stdio) started\n');
}
