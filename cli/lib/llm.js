/**
 * LLM — 精简版 LLM 客户端
 *
 * 基于环境变量配置，通过 OpenAI SDK 调用兼容 API。
 * 支持 OpenAI / Anthropic / DeepSeek 等所有 OpenAI-API 兼容接口。
 */

import OpenAI from 'openai';

let _client = null;

function getClient() {
    if (_client) return _client;
    const baseURL = process.env.LLM_API_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    if (!baseURL || !apiKey) throw new Error('LLM_API_BASE_URL 和 LLM_API_KEY 环境变量未设置');
    _client = new OpenAI({ apiKey, baseURL });
    return _client;
}

function getModel() {
    return process.env.LLM_API_MODEL || 'gpt-4.1-mini';
}

/**
 * 单轮文本对话
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Object} [options]
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @returns {Promise<string>} 助理回复文本
 */
export async function chat(systemPrompt, userMessage, options = {}) {
    const client = getClient();
    const model = options.model || getModel();

    const completion = await client.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
    });

    return completion.choices[0]?.message?.content?.trim() || '';
}

/**
 * 多轮对话
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options]
 * @returns {Promise<string>}
 */
export async function chatMessages(messages, options = {}) {
    const client = getClient();
    const model = options.model || getModel();

    const completion = await client.chat.completions.create({
        model,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
    });

    return completion.choices[0]?.message?.content?.trim() || '';
}
