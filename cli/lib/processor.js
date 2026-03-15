/**
 * Processor — AI 知识加工引擎
 *
 * 在 flomo 笔记基础上叠加 AI 分析能力：
 *   - 洞察发现（规律/主题/变化）
 *   - 标签建议（为无标签笔记推荐标签）
 *   - 关联分析（跨标签/跨时间连接）
 *   - 观点追踪（话题演变轨迹）
 *   - 写作辅助（大纲/素材搜集）
 *   - 标签审计（体系优化建议）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat } from './llm.js';
import { cacheMemos, saveInsight } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

async function loadPrompt(name) {
    return fs.readFile(path.join(PROMPTS_DIR, `${name}.txt`), 'utf-8');
}

async function getFlomoClient() {
    const FlomoMcpClient = (await import('./flomo-mcp-client.js')).default;
    return FlomoMcpClient.getInstance();
}

function formatMemosForLLM(memos) {
    return memos
        .map((m, i) => {
            const meta = [m.id, m.created_at, m.tags].filter(Boolean).join(' | ');
            return `--- 笔记 ${i + 1} [${meta}] ---\n${m.content || m.raw || '(空)'}`;
        })
        .join('\n\n');
}

function extractMemos(result) {
    if (Array.isArray(result)) return result;
    if (result?.memos) return result.memos;
    if (result?.data) return result.data;
    if (result?.items) return result.items;
    return [];
}

// ── 洞察发现 ─────────────────────────────────────────────────────────

/**
 * 分析笔记中的规律和主题
 * @param {Object} [options]
 * @param {string} [options.tag] 限定标签范围
 * @param {string|number} [options.period] 时间范围（天）
 * @param {number} [options.limit] 笔记数量
 * @returns {Promise<Object>}
 */
export async function generateInsights(options = {}) {
    const client = await getFlomoClient();

    const searchParams = { limit: options.limit || 50 };
    if (options.tag) searchParams.tag = options.tag;
    if (options.period) {
        const from = new Date();
        from.setDate(from.getDate() - parseInt(options.period, 10));
        searchParams.from = from.toISOString().split('T')[0];
    }

    const result = await client.memoSearch(searchParams);
    const memos = extractMemos(result);
    await client.disconnect();

    if (!memos.length) {
        return { status: 'empty', message: '未找到匹配的笔记' };
    }

    await cacheMemos(memos);

    const systemPrompt = await loadPrompt('insight');
    const userMessage = formatMemosForLLM(memos);
    const analysis = await chat(systemPrompt, userMessage, { maxTokens: 4096 });

    const insightId = await saveInsight({
        type: 'insight',
        scope: options.tag || 'all',
        content: analysis,
        memo_ids: memos.map(m => m.id),
    });

    return {
        status: 'success',
        insight_id: insightId,
        memo_count: memos.length,
        analysis,
    };
}

// ── 观点演变追踪 ─────────────────────────────────────────────────────

/**
 * 追踪某话题的观点变化
 * @param {string} topic
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function trackEvolution(topic, options = {}) {
    const client = await getFlomoClient();
    const result = await client.memoSearch({ query: topic, limit: options.limit || 30 });
    const memos = extractMemos(result);
    await client.disconnect();

    if (!memos.length) {
        return { status: 'empty', message: `未找到关于"${topic}"的笔记` };
    }

    await cacheMemos(memos);

    const systemPrompt = `你是一位思维追踪专家。请分析以下关于"${topic}"的笔记，梳理用户在这个话题上的观点演变过程。

要求：
- 按时间线标注关键转折点
- 指出观点从 A 变成 B 的证据
- 如果观点矛盾，直接指出
- 最后总结当前的最新立场
- 用中文回答`;

    const analysis = await chat(systemPrompt, formatMemosForLLM(memos), { maxTokens: 4096 });

    await saveInsight({
        type: 'evolution',
        scope: topic,
        content: analysis,
        memo_ids: memos.map(m => m.id),
    });

    return { status: 'success', topic, memo_count: memos.length, analysis };
}

// ── 关联发现 ─────────────────────────────────────────────────────────

/**
 * 发现跨标签/跨时间的隐藏关联
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function findConnections(options = {}) {
    const client = await getFlomoClient();

    const searchParams = { limit: options.limit || 50 };
    if (options.tag) searchParams.tag = options.tag;

    const result = await client.memoSearch(searchParams);
    const memos = extractMemos(result);
    await client.disconnect();

    if (!memos.length) {
        return { status: 'empty', message: '未找到笔记' };
    }

    await cacheMemos(memos);

    const systemPrompt = await loadPrompt('relate');
    const analysis = await chat(systemPrompt, formatMemosForLLM(memos), { maxTokens: 4096 });

    await saveInsight({
        type: 'connections',
        scope: options.tag || 'all',
        content: analysis,
        memo_ids: memos.map(m => m.id),
    });

    return { status: 'success', memo_count: memos.length, analysis };
}

// ── 写作大纲 ─────────────────────────────────────────────────────────

/**
 * 从笔记素材生成写作大纲
 * @param {string} topic
 * @returns {Promise<Object>}
 */
export async function draftOutline(topic) {
    const client = await getFlomoClient();
    const result = await client.memoSearch({ query: topic, limit: 30 });
    const memos = extractMemos(result);
    await client.disconnect();

    if (!memos.length) {
        return { status: 'empty', message: `未找到关于"${topic}"的笔记素材` };
    }

    await cacheMemos(memos);

    let systemPrompt = await loadPrompt('outline');
    systemPrompt = systemPrompt.replace('{{TOPIC}}', topic);

    const outline = await chat(systemPrompt, formatMemosForLLM(memos), { maxTokens: 4096 });

    return { status: 'success', topic, memo_count: memos.length, outline };
}

// ── 素材搜集 ─────────────────────────────────────────────────────────

/**
 * 搜集某主题相关的笔记素材
 * @param {string} topic
 * @returns {Promise<Object>}
 */
export async function collectMaterial(topic) {
    const client = await getFlomoClient();
    const result = await client.memoSearch({ query: topic, limit: 30 });
    const memos = extractMemos(result);

    const recommended = [];
    for (const memo of memos.slice(0, 5)) {
        try {
            const rec = await client.memoRecommended(memo.id);
            const recMemos = extractMemos(rec);
            recommended.push(...recMemos);
        } catch { /* skip */ }
    }

    await client.disconnect();

    const allMemos = [...memos];
    const seenIds = new Set(memos.map(m => m.id));
    for (const m of recommended) {
        if (!seenIds.has(m.id)) {
            allMemos.push(m);
            seenIds.add(m.id);
        }
    }

    await cacheMemos(allMemos);

    return {
        status: 'success',
        topic,
        direct_matches: memos.length,
        related_additions: allMemos.length - memos.length,
        total: allMemos.length,
        memos: allMemos,
    };
}

// ── 标签建议 ─────────────────────────────────────────────────────────

/**
 * 为无标签笔记建议标签
 * @param {Object} [options]
 * @param {number} [options.limit]
 * @returns {Promise<Object>}
 */
export async function suggestTags(options = {}) {
    const client = await getFlomoClient();

    const tagTreeResult = await client.tagTree();

    const searchResult = await client.memoSearch({ limit: options.limit || 20 });
    const allMemos = extractMemos(searchResult);

    const untaggedMemos = allMemos.filter(m => {
        const content = m.content || '';
        return !content.match(/#\S+/);
    });

    await client.disconnect();

    if (!untaggedMemos.length) {
        return { status: 'empty', message: '没有找到无标签的笔记' };
    }

    let systemPrompt = await loadPrompt('tag-suggest');
    const tagTree = typeof tagTreeResult === 'string' ? tagTreeResult : JSON.stringify(tagTreeResult, null, 2);
    systemPrompt = systemPrompt.replace('{{TAG_TREE}}', tagTree);

    const userMessage = formatMemosForLLM(untaggedMemos);
    const suggestions = await chat(systemPrompt, userMessage, { temperature: 0.3, maxTokens: 4096 });

    return {
        status: 'success',
        untagged_count: untaggedMemos.length,
        suggestions,
    };
}

// ── 标签审计 ─────────────────────────────────────────────────────────

/**
 * 分析标签体系问题并给出优化建议
 * @returns {Promise<Object>}
 */
export async function auditTags() {
    const client = await getFlomoClient();
    const tagTreeResult = await client.tagTree();
    await client.disconnect();

    const tagTree = typeof tagTreeResult === 'string' ? tagTreeResult : JSON.stringify(tagTreeResult, null, 2);

    const systemPrompt = `你是一位知识管理专家，擅长设计标签体系。请分析以下 flomo 标签树，给出优化建议。

分析维度：
1. **重复或高度相似的标签**：哪些标签内容重叠，应该合并？
2. **命名不一致**：是否存在风格不统一的命名？（如有些用中文有些用英文，有些用名词有些用动词）
3. **层级问题**：哪些标签层级过深或过浅？是否有标签放错了位置？
4. **缺失建议**：根据现有体系，是否缺少某些显而易见的分类？

请给出具体的操作建议（合并、重命名、移动等），用中文回答。`;

    const analysis = await chat(systemPrompt, tagTree, { temperature: 0.3, maxTokens: 4096 });

    return { status: 'success', analysis };
}
