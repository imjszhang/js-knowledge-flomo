#!/usr/bin/env node

/**
 * js-knowledge-flomo CLI
 *
 * Usage:
 *   node cli/cli.js <command> [options]
 *
 * Commands:
 *   auth                                 OAuth 授权
 *   write <text>      [--tag <tag>]      写入笔记
 *   update <id> <text>                   更新笔记
 *   search <query>    [--tag] [--from] [--to] [--limit]  搜索笔记
 *   get <id...>                          批量获取笔记
 *   related <id>                         相关笔记推荐
 *   tags                                 查看标签树
 *   tag-search <query>                   搜索标签
 *   tag-rename <old> <new>               重命名标签
 *   insights          [--tag] [--period] AI 洞察
 *   evolution <topic>                    观点演变追踪
 *   connections       [--tag]            关联发现
 *   outline <topic>                      写作大纲
 *   material <topic>                     搜集素材
 *   suggest-tags      [--limit]          AI 标签建议
 *   tag-audit                            标签体系审计
 *   serve             [--port]           启动 Web UI
 *   stats                                本地缓存统计
 *
 * All structured output is JSON to stdout. Logs go to stderr.
 */

import 'dotenv/config';
import { toJson, toStderr } from './lib/formatters.js';

// ── Arg parser ───────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = argv.slice(2);
    const command = args[0] || '';
    const positional = [];
    const flags = {};

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) { flags[key] = next; i++; }
            else flags[key] = true;
        } else {
            positional.push(arg);
        }
    }
    return { command, positional, flags };
}

// ── Command: auth ────────────────────────────────────────────────────

async function cmdAuth(flags) {
    const { getAccessToken, clearAuth } = await import('./lib/auth.js');

    if (flags.logout) {
        await clearAuth();
        toJson({ status: 'success', message: '已清除本地认证信息' });
        return;
    }

    const token = await getAccessToken({ force: !!flags.force });
    toJson({ status: 'success', message: '认证成功', token_preview: token.slice(0, 12) + '...' });
}

// ── Command: write ───────────────────────────────────────────────────

async function cmdWrite(positional, flags) {
    const text = positional.join(' ');
    if (!text) {
        toStderr('Error: write 需要提供笔记内容');
        process.exit(1);
    }

    let content = text;
    if (flags.tag) {
        const tags = flags.tag.split(',').map(t => t.trim().startsWith('#') ? t.trim() : `#${t.trim()}`);
        content = tags.join(' ') + '\n' + content;
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.memoCreate(content);
    await client.disconnect();
    toJson(result);
}

// ── Command: update ──────────────────────────────────────────────────

async function cmdUpdate(positional) {
    const id = positional[0];
    const content = positional.slice(1).join(' ');
    if (!id || !content) {
        toStderr('Error: update 需要提供笔记 ID 和新内容');
        process.exit(1);
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.memoUpdate(id, content);
    await client.disconnect();
    toJson(result);
}

// ── Command: search ──────────────────────────────────────────────────

async function cmdSearch(positional, flags) {
    const query = positional.join(' ');
    if (!query && !flags.tag) {
        toStderr('Error: search 需要提供关键词或 --tag');
        process.exit(1);
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.memoSearch({
        query: query || undefined,
        tag: flags.tag,
        from: flags.from,
        to: flags.to,
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
    });
    await client.disconnect();
    toJson(result);
}

// ── Command: get ─────────────────────────────────────────────────────

async function cmdGet(positional) {
    if (!positional.length) {
        toStderr('Error: get 需要提供一个或多个笔记 ID');
        process.exit(1);
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.memoBatchGet(positional);
    await client.disconnect();
    toJson(result);
}

// ── Command: related ─────────────────────────────────────────────────

async function cmdRelated(positional) {
    const id = positional[0];
    if (!id) {
        toStderr('Error: related 需要提供笔记 ID');
        process.exit(1);
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.memoRecommended(id);
    await client.disconnect();
    toJson(result);
}

// ── Command: tags ────────────────────────────────────────────────────

async function cmdTags() {
    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.tagTree();
    await client.disconnect();
    toJson(result);
}

// ── Command: tag-search ──────────────────────────────────────────────

async function cmdTagSearch(positional) {
    const query = positional.join(' ');
    if (!query) {
        toStderr('Error: tag-search 需要提供关键词');
        process.exit(1);
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.tagSearch(query);
    await client.disconnect();
    toJson(result);
}

// ── Command: tag-rename ──────────────────────────────────────────────

async function cmdTagRename(positional) {
    const [oldName, newName] = positional;
    if (!oldName || !newName) {
        toStderr('Error: tag-rename 需要提供旧标签名和新标签名');
        process.exit(1);
    }

    const FlomoMcpClient = (await import('./lib/flomo-mcp-client.js')).default;
    const client = await FlomoMcpClient.getInstance();
    const result = await client.tagRename(oldName, newName);
    await client.disconnect();
    toJson(result);
}

// ── Command: insights ────────────────────────────────────────────────

async function cmdInsights(flags) {
    const { generateInsights } = await import('./lib/processor.js');
    const result = await generateInsights({
        tag: flags.tag,
        period: flags.period,
        limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
    });
    toJson(result);
}

// ── Command: evolution ───────────────────────────────────────────────

async function cmdEvolution(positional, flags) {
    const topic = positional.join(' ');
    if (!topic) {
        toStderr('Error: evolution 需要提供话题');
        process.exit(1);
    }

    const { trackEvolution } = await import('./lib/processor.js');
    const result = await trackEvolution(topic, { limit: flags.limit ? parseInt(flags.limit, 10) : undefined });
    toJson(result);
}

// ── Command: connections ─────────────────────────────────────────────

async function cmdConnections(flags) {
    const { findConnections } = await import('./lib/processor.js');
    const result = await findConnections({ tag: flags.tag, limit: flags.limit ? parseInt(flags.limit, 10) : undefined });
    toJson(result);
}

// ── Command: outline ─────────────────────────────────────────────────

async function cmdOutline(positional) {
    const topic = positional.join(' ');
    if (!topic) {
        toStderr('Error: outline 需要提供写作主题');
        process.exit(1);
    }

    const { draftOutline } = await import('./lib/processor.js');
    const result = await draftOutline(topic);
    toJson(result);
}

// ── Command: material ────────────────────────────────────────────────

async function cmdMaterial(positional) {
    const topic = positional.join(' ');
    if (!topic) {
        toStderr('Error: material 需要提供主题');
        process.exit(1);
    }

    const { collectMaterial } = await import('./lib/processor.js');
    const result = await collectMaterial(topic);
    toJson(result);
}

// ── Command: suggest-tags ────────────────────────────────────────────

async function cmdSuggestTags(flags) {
    const { suggestTags } = await import('./lib/processor.js');
    const result = await suggestTags({ limit: flags.limit ? parseInt(flags.limit, 10) : undefined });
    toJson(result);
}

// ── Command: tag-audit ───────────────────────────────────────────────

async function cmdTagAudit() {
    const { auditTags } = await import('./lib/processor.js');
    const result = await auditTags();
    toJson(result);
}

// ── Command: serve ───────────────────────────────────────────────────

async function cmdServe(flags) {
    const { startServer } = await import('./lib/server.js');
    await startServer({ port: flags.port || 3000 });
}

// ── Command: stats ───────────────────────────────────────────────────

async function cmdStats() {
    const { getStats } = await import('./lib/database.js');
    const result = await getStats();
    toJson(result);
}

// ── Usage ────────────────────────────────────────────────────────────

function printUsage() {
    toStderr(`js-knowledge-flomo CLI — 以 flomo 为核心的知识管理工具

Usage:
  node cli/cli.js <command> [options]

认证:
  auth                         执行 OAuth 授权
    --force                      强制重新授权
    --logout                     清除本地认证

记录:
  write <text>                 写入笔记到 flomo
    --tag <tags>                 逗号分隔的标签
  update <id> <text>           更新笔记内容

搜索:
  search <query>               搜索笔记
    --tag <tag>                  按标签筛选
    --from <date>                起始日期
    --to <date>                  结束日期
    --limit <N>                  返回数量
  get <id...>                  批量获取笔记
  related <id>                 查找相关笔记

标签:
  tags                         查看标签树
  tag-search <query>           搜索标签
  tag-rename <old> <new>       重命名标签

洞察 (AI):
  insights                     分析笔记规律
    --tag <tag>                  限定标签范围
    --period <days>              时间范围（天）
  evolution <topic>            追踪观点变化
  connections                  关联发现
    --tag <tag>                  限定标签范围

写作 (AI):
  outline <topic>              从笔记生成写作大纲
  material <topic>             搜集相关笔记素材

整理 (AI):
  suggest-tags                 AI 为无标签笔记建议标签
    --limit <N>                  处理数量
  tag-audit                    AI 分析标签体系问题

其他:
  serve                        启动 Web UI
    --port <N>                   端口号（默认 3000）
  stats                        本地缓存统计

示例:
  node cli/cli.js auth
  node cli/cli.js write "今天想到一个关于产品设计的思路" --tag "产品,思考"
  node cli/cli.js search "产品设计" --tag "产品"
  node cli/cli.js insights --tag "产品" --period 30
  node cli/cli.js outline "为什么小团队应该克制增长"
  node cli/cli.js suggest-tags --limit 20`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
    const { command, positional, flags } = parseArgs(process.argv);

    switch (command) {
        case 'auth':          await cmdAuth(flags);                    break;
        case 'write':         await cmdWrite(positional, flags);       break;
        case 'update':        await cmdUpdate(positional);             break;
        case 'search':        await cmdSearch(positional, flags);      break;
        case 'get':           await cmdGet(positional);                break;
        case 'related':       await cmdRelated(positional);            break;
        case 'tags':          await cmdTags();                         break;
        case 'tag-search':    await cmdTagSearch(positional);          break;
        case 'tag-rename':    await cmdTagRename(positional);          break;
        case 'insights':      await cmdInsights(flags);                break;
        case 'evolution':     await cmdEvolution(positional, flags);   break;
        case 'connections':   await cmdConnections(flags);             break;
        case 'outline':       await cmdOutline(positional);            break;
        case 'material':      await cmdMaterial(positional);           break;
        case 'suggest-tags':  await cmdSuggestTags(flags);             break;
        case 'tag-audit':     await cmdTagAudit();                     break;
        case 'serve':         await cmdServe(flags);                   break;
        case 'stats':         await cmdStats();                        break;
        case 'help': case '--help': case '-h':
            printUsage();
            break;
        case '':
            printUsage();
            process.exit(1);
            break;
        default:
            toStderr(`Error: 未知命令 "${command}"`);
            toStderr('运行 "node cli/cli.js help" 查看帮助。');
            process.exit(1);
    }
}

main().catch(err => {
    toStderr(`Error: ${err.message}`);
    process.exit(1);
});
