/**
 * Auth — flomo MCP OAuth 认证
 *
 * 首次使用时通过本地 HTTP 回调服务器完成 OAuth 授权，
 * token 持久化到 ~/.flomo-auth.json，后续自动加载。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { URL } from 'node:url';

const AUTH_FILE = path.join(os.homedir(), '.flomo-auth.json');
const CALLBACK_PORT = 19836;
const CALLBACK_PATH = '/callback';

/**
 * 读取已保存的认证信息
 * @returns {Promise<Object|null>}
 */
export async function loadAuth() {
    try {
        const raw = await fs.readFile(AUTH_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data.access_token) return data;
    } catch { /* not found or invalid */ }
    return null;
}

/**
 * 保存认证信息到本地文件
 * @param {Object} authData
 */
export async function saveAuth(authData) {
    await fs.writeFile(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf-8');
}

/**
 * 清除本地认证信息
 */
export async function clearAuth() {
    try { await fs.unlink(AUTH_FILE); } catch { /* ignore */ }
}

/**
 * 获取有效的 access_token，如果不存在则启动 OAuth 流程
 * @param {Object} [options]
 * @param {boolean} [options.force] 强制重新授权
 * @returns {Promise<string>} access_token
 */
export async function getAccessToken(options = {}) {
    if (!options.force) {
        const saved = await loadAuth();
        if (saved?.access_token) {
            if (saved.expires_at && Date.now() >= saved.expires_at && saved.refresh_token) {
                return await refreshAccessToken(saved);
            }
            return saved.access_token;
        }
    }
    return await startOAuthFlow();
}

/**
 * 发现 flomo MCP 的 OAuth 元数据
 * @param {string} mcpUrl
 * @returns {Promise<Object>} OAuth metadata
 */
async function discoverOAuthMetadata(mcpUrl) {
    const base = new URL(mcpUrl);
    const wellKnown = new URL('/.well-known/oauth-authorization-server', base.origin);

    const res = await fetch(wellKnown.href);
    if (!res.ok) {
        throw new Error(`OAuth 元数据发现失败: ${res.status} ${res.statusText}`);
    }
    return await res.json();
}

/**
 * 动态客户端注册
 * @param {string} registrationEndpoint
 * @returns {Promise<Object>} client credentials
 */
async function registerClient(registrationEndpoint) {
    const res = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'js-knowledge-flomo',
            redirect_uris: [`http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        }),
    });
    if (!res.ok) {
        throw new Error(`客户端注册失败: ${res.status} ${await res.text()}`);
    }
    return await res.json();
}

/**
 * 启动完整 OAuth 授权流程
 * @returns {Promise<string>} access_token
 */
async function startOAuthFlow() {
    const mcpUrl = process.env.FLOMO_MCP_URL || 'https://flomoapp.com/mcp';
    const { stderr } = await import('node:process');

    stderr.write('正在发现 flomo OAuth 配置...\n');
    const metadata = await discoverOAuthMetadata(mcpUrl);

    stderr.write('正在注册客户端...\n');
    const clientInfo = await registerClient(metadata.registration_endpoint);

    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomUUID() + crypto.randomUUID();

    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientInfo.client_id);
    authUrl.searchParams.set('redirect_uri', `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (metadata.scopes_supported) {
        authUrl.searchParams.set('scope', metadata.scopes_supported.join(' '));
    }

    const code = await openBrowserAndWaitForCallback(authUrl.href, state);

    stderr.write('正在交换 access_token...\n');
    const tokenRes = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientInfo.client_id,
            redirect_uri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
            code_verifier: codeVerifier,
        }),
    });

    if (!tokenRes.ok) {
        throw new Error(`Token 交换失败: ${tokenRes.status} ${await tokenRes.text()}`);
    }

    const tokenData = await tokenRes.json();
    const authData = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        expires_at: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
        token_endpoint: metadata.token_endpoint,
        registration_endpoint: metadata.registration_endpoint,
        client_id: clientInfo.client_id,
    };

    await saveAuth(authData);
    stderr.write('授权成功！token 已保存。\n');
    return authData.access_token;
}

/**
 * 刷新 access_token
 */
async function refreshAccessToken(saved) {
    const { stderr } = await import('node:process');
    stderr.write('正在刷新 access_token...\n');

    const res = await fetch(saved.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: saved.refresh_token,
            client_id: saved.client_id,
        }),
    });

    if (!res.ok) {
        stderr.write('Token 刷新失败，重新授权...\n');
        await clearAuth();
        return await startOAuthFlow();
    }

    const tokenData = await res.json();
    const authData = {
        ...saved,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || saved.refresh_token,
        expires_at: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
    };

    await saveAuth(authData);
    return authData.access_token;
}

/**
 * 生成 PKCE code_challenge (S256)
 */
async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * 打开浏览器并启动本地回调服务器，等待 OAuth 回调
 * @returns {Promise<string>} authorization code
 */
function openBrowserAndWaitForCallback(authUrl, expectedState) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
            if (url.pathname !== CALLBACK_PATH) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>授权失败</h1><p>可以关闭此页面。</p>');
                server.close();
                reject(new Error(`OAuth 授权失败: ${error}`));
                return;
            }

            if (state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>状态验证失败</h1>');
                server.close();
                reject(new Error('OAuth state 不匹配'));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>授权成功！</h1><p>可以关闭此页面，返回终端继续操作。</p>');
            server.close();
            resolve(code);
        });

        server.listen(CALLBACK_PORT, '127.0.0.1', async () => {
            process.stderr.write(`\n请在浏览器中完成授权:\n${authUrl}\n\n`);
            try {
                const open = (await import('open')).default;
                await open(authUrl);
            } catch {
                process.stderr.write('（无法自动打开浏览器，请手动复制上面的链接）\n');
            }
        });

        server.on('error', reject);
        setTimeout(() => {
            server.close();
            reject(new Error('OAuth 授权超时（3 分钟）'));
        }, 180_000);
    });
}
