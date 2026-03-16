/**
 * Server — HTTP 服务（Web UI + REST API）
 *
 * 提供本地 Web UI 和 REST API 接口。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

function sendJson(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
}

function sendError(res, message, status = 500) {
    sendJson(res, { error: message }, status);
}

/**
 * 启动 HTTP 服务
 * @param {Object} options
 * @param {number} [options.port]
 */
export async function startServer(options = {}) {
    const port = parseInt(options.port, 10) || 3000;

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
        }

        try {
            if (url.pathname.startsWith('/api/')) {
                await handleApi(req, res, url);
            } else {
                serveStatic(req, res, url);
            }
        } catch (err) {
            process.stderr.write(`Server error: ${err.message}\n`);
            sendError(res, err.message);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        process.stderr.write(`Web UI: http://127.0.0.1:${port}\n`);
        process.stderr.write(`API:    http://127.0.0.1:${port}/api/\n`);
    });
}

// ── Static files ─────────────────────────────────────────────────────

function serveStatic(req, res, url) {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = path.join(SRC_DIR, filePath);

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        const indexPath = path.join(SRC_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            fs.createReadStream(indexPath).pipe(res);
            return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    const ext = path.extname(fullPath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(fullPath).pipe(res);
}

// ── API routes ───────────────────────────────────────────────────────

async function handleApi(req, res, url) {
    const route = url.pathname.replace('/api/', '');

    switch (route) {
        case 'search': {
            const query = url.searchParams.get('q') || '';
            const tag = url.searchParams.get('tag') || '';
            const limit = parseInt(url.searchParams.get('limit') || '20', 10);
            const FlomoMcpClient = (await import('./flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.memoSearch({ query: query || undefined, tag: tag || undefined, limit });
            await client.disconnect();
            sendJson(res, result);
            break;
        }

        case 'tags': {
            const FlomoMcpClient = (await import('./flomo-mcp-client.js')).default;
            const client = await FlomoMcpClient.getInstance();
            const result = await client.tagTree();
            await client.disconnect();
            sendJson(res, result);
            break;
        }

        case 'insights': {
            const tag = url.searchParams.get('tag') || '';
            const period = url.searchParams.get('period') || '';
            const { generateInsights } = await import('./processor.js');
            const result = await generateInsights({
                tag: tag || undefined,
                period: period || undefined,
            });
            sendJson(res, result);
            break;
        }

        case 'stats': {
            const { getStats } = await import('./database.js');
            const result = await getStats();
            sendJson(res, result);
            break;
        }

        case 'cached-insights': {
            const { getInsights } = await import('./database.js');
            const type = url.searchParams.get('type') || '';
            const result = await getInsights({ type: type || undefined });
            sendJson(res, result);
            break;
        }

        default:
            sendError(res, `Unknown API route: ${route}`, 404);
    }
}
