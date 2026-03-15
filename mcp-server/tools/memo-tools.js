/**
 * Memo Tools — flomo 笔记透传工具 + AI 增强
 *
 * 透传 flomo MCP 的笔记操作，同时可选地缓存到本地。
 */

import { z } from 'zod';

/**
 * 注册笔记相关工具到 MCP Server
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerMemoTools(server) {

    server.tool(
        'memo_create',
        '创建 flomo 笔记，支持标签和格式',
        { content: z.string().describe('笔记内容（可包含 #标签）') },
        async ({ content }) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.memoCreate(content);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'memo_update',
        '更新已有 flomo 笔记的内容',
        {
            id: z.string().describe('笔记 ID'),
            content: z.string().describe('新的笔记内容'),
        },
        async ({ id, content }) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.memoUpdate(id, content);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'memo_search',
        '搜索 flomo 笔记，支持关键词、标签、时间范围和语义搜索',
        {
            query: z.string().optional().describe('搜索关键词'),
            tag: z.string().optional().describe('按标签筛选'),
            from: z.string().optional().describe('起始日期 (YYYY-MM-DD)'),
            to: z.string().optional().describe('结束日期 (YYYY-MM-DD)'),
            limit: z.number().optional().describe('返回数量'),
        },
        async (params) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.memoSearch(params);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'memo_batch_get',
        '批量获取多条 flomo 笔记的完整内容',
        { ids: z.array(z.string()).describe('笔记 ID 列表') },
        async ({ ids }) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.memoBatchGet(ids);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'memo_recommended',
        '根据一条笔记找出内容相关的其他笔记',
        { id: z.string().describe('笔记 ID') },
        async ({ id }) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.memoRecommended(id);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );
}
