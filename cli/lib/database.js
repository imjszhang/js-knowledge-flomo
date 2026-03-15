/**
 * Database — 本地 SQLite 缓存层
 *
 * 缓存 flomo 笔记搜索结果，存储 AI 洞察报告，提供全文索引加速。
 * 不作为主存储，flomo 远端始终为数据权威来源。
 */

import sqlite3Pkg from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const sqlite3 = sqlite3Pkg.verbose();

let _db = null;
let _dbPath = null;

function getDbPath() {
    return process.env.DB_PATH || path.resolve('data', 'cache.db');
}

function getDb() {
    if (_db) return _db;
    throw new Error('数据库未初始化，请先调用 initDb()');
}

/**
 * 初始化数据库连接并建表
 */
export async function initDb() {
    if (_db) return;
    _dbPath = getDbPath();
    const dir = path.dirname(_dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    _db = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(
            _dbPath,
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            (err) => err ? reject(err) : resolve(db),
        );
    });

    await run('PRAGMA journal_mode = WAL');
    await run('PRAGMA busy_timeout = 5000');

    await run(`
        CREATE TABLE IF NOT EXISTS memo_cache (
            id TEXT PRIMARY KEY,
            content TEXT,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT,
            cached_at TEXT DEFAULT (datetime('now'))
        )
    `);

    await run(`
        CREATE TABLE IF NOT EXISTS insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            scope TEXT,
            content TEXT NOT NULL,
            memo_ids TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);

    await run('CREATE INDEX IF NOT EXISTS idx_memo_cache_tags ON memo_cache(tags)');
    await run('CREATE INDEX IF NOT EXISTS idx_memo_cache_created ON memo_cache(created_at)');
    await run('CREATE INDEX IF NOT EXISTS idx_insights_type ON insights(type)');
}

/**
 * 关闭数据库连接
 */
export async function closeDb() {
    if (!_db) return;
    await new Promise((resolve, reject) => {
        _db.close((err) => {
            if (err) return reject(err);
            _db = null;
            resolve();
        });
    });
}

// ── Low-level helpers ────────────────────────────────────────────────

function run(query, params = []) {
    return new Promise((resolve, reject) => {
        getDb().run(query, params, function (err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(query, params = []) {
    return new Promise((resolve, reject) => {
        getDb().get(query, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(query, params = []) {
    return new Promise((resolve, reject) => {
        getDb().all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

// ── Memo cache ───────────────────────────────────────────────────────

/**
 * 缓存笔记到本地
 * @param {Object} memo { id, content, tags, created_at, updated_at }
 */
export async function cacheMemo(memo) {
    await initDb();
    const tags = Array.isArray(memo.tags) ? memo.tags.join(',') : (memo.tags || '');
    await run(
        `INSERT OR REPLACE INTO memo_cache (id, content, tags, created_at, updated_at, cached_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [memo.id, memo.content || '', tags, memo.created_at || '', memo.updated_at || ''],
    );
}

/**
 * 批量缓存笔记
 * @param {Array<Object>} memos
 */
export async function cacheMemos(memos) {
    for (const memo of memos) {
        await cacheMemo(memo);
    }
}

/**
 * 从缓存获取笔记
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getCachedMemo(id) {
    await initDb();
    return get('SELECT * FROM memo_cache WHERE id = ?', [id]);
}

/**
 * 搜索本地缓存
 * @param {Object} options
 * @returns {Promise<Array>}
 */
export async function searchCachedMemos(options = {}) {
    await initDb();
    const conditions = [];
    const params = [];

    if (options.keyword) {
        conditions.push('content LIKE ?');
        params.push(`%${options.keyword}%`);
    }
    if (options.tag) {
        conditions.push('tags LIKE ?');
        params.push(`%${options.tag}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 50;
    return all(`SELECT * FROM memo_cache ${where} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
}

// ── Insights storage ─────────────────────────────────────────────────

/**
 * 保存 AI 洞察报告
 * @param {Object} insight { type, scope, content, memo_ids }
 * @returns {Promise<number>} insert id
 */
export async function saveInsight(insight) {
    await initDb();
    const memoIds = Array.isArray(insight.memo_ids) ? insight.memo_ids.join(',') : (insight.memo_ids || '');
    const result = await run(
        `INSERT INTO insights (type, scope, content, memo_ids) VALUES (?, ?, ?, ?)`,
        [insight.type, insight.scope || '', insight.content, memoIds],
    );
    return result.lastID;
}

/**
 * 获取历史洞察
 * @param {Object} [options]
 * @returns {Promise<Array>}
 */
export async function getInsights(options = {}) {
    await initDb();
    const conditions = [];
    const params = [];

    if (options.type) {
        conditions.push('type = ?');
        params.push(options.type);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 20;
    return all(`SELECT * FROM insights ${where} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
}

// ── Stats ────────────────────────────────────────────────────────────

/**
 * 获取本地缓存统计
 * @returns {Promise<Object>}
 */
export async function getStats() {
    await initDb();
    const memoCount = (await get('SELECT COUNT(*) as c FROM memo_cache'))?.c ?? 0;
    const insightCount = (await get('SELECT COUNT(*) as c FROM insights'))?.c ?? 0;
    const latestMemo = await get('SELECT cached_at FROM memo_cache ORDER BY cached_at DESC LIMIT 1');
    const latestInsight = await get('SELECT created_at FROM insights ORDER BY created_at DESC LIMIT 1');

    return {
        cached_memos: memoCount,
        insights: insightCount,
        latest_memo_cache: latestMemo?.cached_at || null,
        latest_insight: latestInsight?.created_at || null,
        db_path: _dbPath,
    };
}
