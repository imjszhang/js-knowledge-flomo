/**
 * AI Tools — AI 增强工具（本项目核心价值）
 *
 * 在 flomo 数据基础上叠加 AI 分析能力，
 * 提供洞察、标签建议、关联分析、写作辅助等功能。
 */

import { z } from 'zod';

/**
 * 注册 AI 增强工具到 MCP Server
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerAiTools(server) {

    server.tool(
        'generate_insights',
        '分析 flomo 笔记中的规律、反复主题和隐藏模式',
        {
            tag: z.string().optional().describe('限定标签范围'),
            period: z.number().optional().describe('时间范围（天数）'),
            limit: z.number().optional().describe('分析的笔记数量'),
        },
        async (params) => {
            const { generateInsights } = await import('../../cli/lib/processor.js');
            const result = await generateInsights(params);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'track_evolution',
        '追踪某个话题在 flomo 笔记中的观点演变过程',
        {
            topic: z.string().describe('要追踪的话题'),
            limit: z.number().optional().describe('笔记数量'),
        },
        async ({ topic, limit }) => {
            const { trackEvolution } = await import('../../cli/lib/processor.js');
            const result = await trackEvolution(topic, { limit });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'find_connections',
        '发现 flomo 笔记之间跨标签、跨时间的隐藏关联',
        {
            tag: z.string().optional().describe('限定标签范围'),
            limit: z.number().optional().describe('笔记数量'),
        },
        async (params) => {
            const { findConnections } = await import('../../cli/lib/processor.js');
            const result = await findConnections(params);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'draft_outline',
        '根据 flomo 笔记素材生成写作大纲',
        {
            topic: z.string().describe('写作主题'),
        },
        async ({ topic }) => {
            const { draftOutline } = await import('../../cli/lib/processor.js');
            const result = await draftOutline(topic);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'collect_material',
        '搜集某主题相关的 flomo 笔记素材（含关联推荐）',
        {
            topic: z.string().describe('主题关键词'),
        },
        async ({ topic }) => {
            const { collectMaterial } = await import('../../cli/lib/processor.js');
            const result = await collectMaterial(topic);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'suggest_tags',
        'AI 为无标签的 flomo 笔记建议合适的标签',
        {
            limit: z.number().optional().describe('处理笔记数量'),
        },
        async ({ limit }) => {
            const { suggestTags } = await import('../../cli/lib/processor.js');
            const result = await suggestTags({ limit });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );

    server.tool(
        'audit_tags',
        '分析 flomo 标签体系，给出优化建议（重复/命名/层级问题）',
        {},
        async () => {
            const { auditTags } = await import('../../cli/lib/processor.js');
            const result = await auditTags();
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        },
    );
}
