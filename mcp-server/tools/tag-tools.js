/**
 * Tag Tools — flomo 标签透传工具
 */

import { z } from 'zod';

/**
 * 注册标签相关工具到 MCP Server
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerTagTools(server) {

    server.tool(
        'tag_tree',
        '获取 flomo 完整的标签层级结构',
        {},
        async () => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.tagTree();
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'tag_search',
        '按关键词搜索 flomo 标签',
        { query: z.string().describe('搜索关键词') },
        async ({ query }) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.tagSearch(query);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'tag_rename',
        '重命名 flomo 标签，所有关联笔记同步更新',
        {
            old_name: z.string().describe('原标签名'),
            new_name: z.string().describe('新标签名'),
        },
        async ({ old_name, new_name }) => {
            const FlomoMcpClient = (await import('../../cli/lib/flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.tagRename(old_name, new_name);
            await client.disconnect();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );
}
