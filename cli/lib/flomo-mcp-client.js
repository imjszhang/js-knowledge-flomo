/**
 * FlomoMcpClient — flomo MCP 客户端
 *
 * 通过 Streamable HTTP 连接 flomo 官方 MCP Server (https://flomoapp.com/mcp)，
 * 封装全部 8 个工具为本地方法。
 *
 * 工具清单（来自 flomo 文档）：
 *   笔记: memo_create / memo_update / memo_search / memo_batch_get / memo_recommended
 *   标签: tag_tree / tag_search / tag_rename
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getAccessToken } from './auth.js';

let _instance = null;

export default class FlomoMcpClient {
    constructor() {
        this.client = null;
        this.transport = null;
        this.connected = false;
    }

    /**
     * 获取单例实例，自动连接
     * @returns {Promise<FlomoMcpClient>}
     */
    static async getInstance() {
        if (_instance?.connected) return _instance;
        _instance = new FlomoMcpClient();
        await _instance.connect();
        return _instance;
    }

    /**
     * 连接到 flomo MCP Server
     */
    async connect() {
        const mcpUrl = process.env.FLOMO_MCP_URL || 'https://flomoapp.com/mcp';
        const accessToken = await getAccessToken();

        this.client = new Client(
            { name: 'js-knowledge-flomo', version: '1.0.0' },
            { capabilities: {} },
        );

        this.transport = new StreamableHTTPClientTransport(
            new URL(mcpUrl),
            {
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                    },
                },
            },
        );

        this.client.onerror = (error) => {
            process.stderr.write(`[MCP Client Error] ${error}\n`);
        };

        await this.client.connect(this.transport);
        this.connected = true;
    }

    /**
     * 断开连接
     */
    async disconnect() {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.transport = null;
            this.connected = false;
            _instance = null;
        }
    }

    /**
     * 调用 flomo MCP 工具
     * @param {string} toolName
     * @param {Object} args
     * @returns {Promise<Object>}
     */
    async callTool(toolName, args = {}) {
        if (!this.connected) throw new Error('MCP Client 未连接');

        const result = await this.client.callTool({ name: toolName, arguments: args });

        if (result.isError) {
            const errorText = result.content
                ?.filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n') || '未知错误';
            throw new Error(`flomo MCP 工具 "${toolName}" 调用失败: ${errorText}`);
        }

        const textContent = result.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n') || '';

        try {
            return JSON.parse(textContent);
        } catch {
            return { raw: textContent };
        }
    }

    /**
     * 列出所有可用工具（用于调试）
     * @returns {Promise<Array>}
     */
    async listTools() {
        if (!this.connected) throw new Error('MCP Client 未连接');
        const result = await this.client.listTools();
        return result.tools || [];
    }

    // ── 笔记工具 ─────────────────────────────────────────────────────

    /**
     * 创建笔记
     * @param {string} content 笔记内容（支持标签和格式）
     * @returns {Promise<Object>}
     */
    async memoCreate(content) {
        return this.callTool('memo_create', { content });
    }

    /**
     * 更新笔记
     * @param {string} id 笔记 ID
     * @param {string} content 新内容
     * @returns {Promise<Object>}
     */
    async memoUpdate(id, content) {
        return this.callTool('memo_update', { id, content });
    }

    /**
     * 搜索笔记
     * @param {Object} params
     * @param {string} [params.query] 关键词 / 语义搜索
     * @param {string} [params.tag] 标签筛选
     * @param {string} [params.from] 起始时间
     * @param {string} [params.to] 结束时间
     * @param {number} [params.limit] 返回数量
     * @param {number} [params.offset] 偏移量
     * @returns {Promise<Object>}
     */
    async memoSearch(params = {}) {
        const args = {};
        if (params.query) args.query = params.query;
        if (params.tag) args.tag = params.tag;
        if (params.from) args.from = params.from;
        if (params.to) args.to = params.to;
        if (params.limit) args.limit = params.limit;
        if (params.offset) args.offset = params.offset;
        return this.callTool('memo_search', args);
    }

    /**
     * 批量获取笔记
     * @param {string[]} ids 笔记 ID 列表
     * @returns {Promise<Object>}
     */
    async memoBatchGet(ids) {
        return this.callTool('memo_batch_get', { ids });
    }

    /**
     * 获取相关推荐笔记
     * @param {string} id 笔记 ID
     * @returns {Promise<Object>}
     */
    async memoRecommended(id) {
        return this.callTool('memo_recommended', { id });
    }

    // ── 标签工具 ─────────────────────────────────────────────────────

    /**
     * 获取完整标签树
     * @returns {Promise<Object>}
     */
    async tagTree() {
        return this.callTool('tag_tree');
    }

    /**
     * 搜索标签
     * @param {string} query 关键词
     * @returns {Promise<Object>}
     */
    async tagSearch(query) {
        return this.callTool('tag_search', { query });
    }

    /**
     * 重命名标签
     * @param {string} oldName 原标签名
     * @param {string} newName 新标签名
     * @returns {Promise<Object>}
     */
    async tagRename(oldName, newName) {
        return this.callTool('tag_rename', { old_name: oldName, new_name: newName });
    }
}
