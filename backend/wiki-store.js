'use strict';
/*
 * Wiki SQLite 存储层（零依赖，使用 Node >= 22.13 内置的 node:sqlite）。
 *
 * 数据布局（数据目录，默认 C:\Users\<用户>\web-fishing-game）：
 *   wiki.db     官方攻略 / 更新记录 / 玩家投稿 / 审核状态 / 修订历史
 *   wiki.json   旧版官方内容（仅首次迁移时读取，保留作备份）
 *   wiki-guides.json  旧版玩家投稿（仅首次迁移时读取，保留作备份）
 *
 * 设计口径：
 *   - 官方内容与玩家投稿共用 guides 表，用 kind = official / user 区分；
 *   - 正文段落拆到 guide_sections，列表/搜索只读 guides（元数据），详情才读段落；
 *   - 每次写操作都在事务里同时更新 meta 里的全局 revision（official_revision / user_revision），
 *     供 ETag 与前端 5 秒轮询使用，不需要再哈希全量 JSON；
 *   - guide_revisions 记录每次提交 / 审核 / 删除 / 官方保存的快照，后续要做版本历史无需改表。
 */
const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { DatabaseSync = null; }

const SCHEMA_VERSION = 1;
const MAX_USER_GUIDES = 10000;
const MAX_REVISIONS = 50000; // 修订历史只保留最近 5 万条，避免无限增长
const META_SCHEMA_VERSION = 'schema_version';
const META_OFFICIAL_REVISION = 'official_revision';
const META_USER_REVISION = 'user_revision';
const META_OFFICIAL_UPDATED_AT = 'official_updated_at';

function nowIso() { return new Date().toISOString(); }
function intOr(value, fallback) {
  const n = Math.floor(Number(value));
  return isFinite(n) ? n : fallback;
}
function readJsonFile(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function jparse(text, fallback) {
  if (text == null || text === '') return fallback;
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function likePattern(q) {
  return '%' + String(q).replace(/[\\%_]/g, function (c) { return '\\' + c; }) + '%';
}

class WikiStore {
  constructor(file) {
    if (!DatabaseSync) {
      throw new Error('Wiki 的 SQLite 存储需要 Node.js >= 22.13（内置 node:sqlite）。当前版本：' + process.version + '；可升级 Node，或用 node --experimental-sqlite 启动。');
    }
    if (!file) throw new Error('Wiki 数据库路径不能为空');
    this.file = path.resolve(String(file));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.createSchema();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guides (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        author_key TEXT,
        author_name TEXT,
        submitted_at TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        review_note TEXT NOT NULL DEFAULT '',
        deleted_at TEXT,
        deleted_by TEXT,
        delete_reason TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guide_sections (
        guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
        ord INTEGER NOT NULL,
        heading TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT,
        items_json TEXT,
        PRIMARY KEY (guide_id, ord)
      );
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS guide_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guide_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        actor_key TEXT,
        actor_name TEXT,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guides_kind_status ON guides(kind, status, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_guides_author ON guides(author_key, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_guides_category ON guides(category);
      CREATE INDEX IF NOT EXISTS idx_guides_updated ON guides(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sections_guide ON guide_sections(guide_id, ord);
      CREATE INDEX IF NOT EXISTS idx_revisions_guide ON guide_revisions(guide_id, revision);
    `);
    if (this.getMeta(META_SCHEMA_VERSION) == null) this.setMeta(META_SCHEMA_VERSION, SCHEMA_VERSION);
  }

  close() { try { this.db.close(); } catch (e) {} }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch (e2) {}
      throw e;
    }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM wiki_meta WHERE key = ?').get(String(key));
    return row ? row.value : null;
  }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO wiki_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value == null ? '' : value));
  }
  getSchemaVersion() { return intOr(this.getMeta(META_SCHEMA_VERSION), 0); }
  getOfficialRevision() { return Math.max(1, intOr(this.getMeta(META_OFFICIAL_REVISION), 1)); }
  getUserRevision() { return Math.max(1, intOr(this.getMeta(META_USER_REVISION), 1)); }
  getOfficialUpdatedAt() { const v = this.getMeta(META_OFFICIAL_UPDATED_AT); return v || null; }
  guideExists(id) { return !!this.db.prepare('SELECT 1 FROM guides WHERE id = ?').get(String(id || '')); }

  // ---- 行 ↔ 对象 ----
  readSections(guideId) {
    return this.db.prepare('SELECT heading, type, text, items_json FROM guide_sections WHERE guide_id = ? ORDER BY ord ASC').all(String(guideId)).map(function (r) {
      if (r.type === 'p' || r.type === 'note') return { h: r.heading, type: r.type, text: r.text || '' };
      return { h: r.heading, type: r.type, items: jparse(r.items_json, []) };
    });
  }
  writeSections(guideId, sections) {
    this.db.prepare('DELETE FROM guide_sections WHERE guide_id = ?').run(String(guideId));
    const ins = this.db.prepare('INSERT INTO guide_sections (guide_id, ord, heading, type, text, items_json) VALUES (?, ?, ?, ?, ?, ?)');
    (Array.isArray(sections) ? sections : []).forEach(function (s, i) {
      const isText = s && (s.type === 'p' || s.type === 'note');
      ins.run(String(guideId), i, String((s && s.h) || ''), String((s && s.type) || 'p'), isText ? String(s.text || '') : null, isText ? null : JSON.stringify((s && s.items) || []));
    });
  }
  rowToGuide(row, withSections) {
    const g = {
      id: row.id, kind: row.kind, status: row.status,
      title: row.title, category: row.category, summary: row.summary,
      tags: jparse(row.tags_json, []), aliases: jparse(row.aliases_json, []),
      authorKey: row.author_key || null, authorName: row.author_name || '',
      submittedAt: row.submitted_at || null, reviewedAt: row.reviewed_at || null,
      reviewedBy: row.reviewed_by || null, reviewNote: row.review_note || '',
      deletedAt: row.deleted_at || null, deletedBy: row.deleted_by || null, deleteReason: row.delete_reason || null,
      revision: intOr(row.revision, 1), updatedAt: row.updated_at
    };
    if (withSections) g.sections = this.readSections(row.id);
    return g;
  }
  writeRevision(guideId, revision, action, actorKey, actorName, snapshot) {
    try {
      this.db.prepare('INSERT INTO guide_revisions (guide_id, revision, action, actor_key, actor_name, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(String(guideId), intOr(revision, 1), String(action || ''), actorKey || null, actorName || null, JSON.stringify(snapshot || {}), nowIso());
      // 单条 DELETE：超过上限时丢掉最旧的修订；行数未超限时是空操作。
      this.db.prepare('DELETE FROM guide_revisions WHERE id <= (SELECT MAX(id) FROM guide_revisions) - ?').run(MAX_REVISIONS);
    } catch (e) {
      // 修订历史是审计辅助，失败不能把主写入拖回滚。
    }
  }
  insertGuideRow(g, opts) {
    const o = opts || {};
    const kind = o.kind || g.kind || 'user';
    const status = o.status || g.status || (kind === 'official' ? 'published' : 'pending');
    const revision = intOr(o.revision, intOr(g.revision, 1));
    const createdAt = g.submittedAt || g.updatedAt || nowIso();
    const updatedAt = g.updatedAt || nowIso();
    this.db.prepare(
      'INSERT INTO guides (id, kind, status, title, category, summary, tags_json, aliases_json, author_key, author_name, submitted_at, reviewed_at, reviewed_by, review_note, deleted_at, deleted_by, delete_reason, revision, sort_order, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      String(g.id), kind, status, String(g.title || ''), String(g.category || ''), String(g.summary || ''),
      JSON.stringify(Array.isArray(g.tags) ? g.tags : []), JSON.stringify(Array.isArray(g.aliases) ? g.aliases : []),
      g.authorKey || null, g.authorName || null, g.submittedAt || null, g.reviewedAt || null, g.reviewedBy || null, g.reviewNote || '',
      g.deletedAt || null, g.deletedBy || null, g.deleteReason || null,
      revision, intOr(o.sortOrder, 0), createdAt, updatedAt
    );
    this.writeSections(g.id, g.sections);
    this.writeRevision(g.id, revision, o.action || 'write', g.authorKey || null, g.authorName || null, g);
  }

  // ---- 首次迁移：旧 JSON → SQLite（旧文件保留作备份） ----
  importLegacy(opts) {
    const o = opts || {};
    const hasGuides = this.db.prepare('SELECT COUNT(*) AS n FROM guides').get().n > 0;
    const hasMeta = this.getMeta(META_OFFICIAL_REVISION) != null;
    if (hasGuides || hasMeta) return { imported: false, official: 0, user: 0 };

    const wikiJson = readJsonFile(o.wikiJsonFile) || {};
    const custom = wikiJson.wikiContent;
    const legacyOfficial = custom && Array.isArray(custom.guides) && custom.guides.length && Array.isArray(custom.updates) ? custom : null;
    const official = legacyOfficial || o.officialSeed || { guides: [], updates: [] };
    const officialRevision = Math.max(1, intOr(wikiJson.wikiContentRevision, 1));
    const officialUpdatedAt = typeof wikiJson.wikiContentUpdatedAt === 'string' ? wikiJson.wikiContentUpdatedAt : '';
    const userFile = readJsonFile(o.wikiGuidesFile) || {};
    const userGuides = Array.isArray(userFile.wikiUserGuides) ? userFile.wikiUserGuides : [];
    const userRevision = Math.max(1, intOr(userFile.wikiUserGuidesRevision, 1));

    this.tx(() => {
      const officialGuides = Array.isArray(official.guides) ? official.guides : [];
      officialGuides.forEach((g, i) => {
        this.insertGuideRow(Object.assign({}, g, { kind: 'official', status: 'published' }), { kind: 'official', status: 'published', sortOrder: i, revision: officialRevision, action: 'import_official' });
      });
      const insUpdate = this.db.prepare('INSERT INTO updates (date, title, summary, sort_order) VALUES (?, ?, ?, ?)');
      (Array.isArray(official.updates) ? official.updates : []).forEach((u, i) => insUpdate.run(u.date, u.title, u.summary, i));
      this.setMeta(META_OFFICIAL_REVISION, officialRevision);
      if (officialUpdatedAt) this.setMeta(META_OFFICIAL_UPDATED_AT, officialUpdatedAt);
      userGuides.forEach(g => this.insertGuideRow(g, { kind: 'user', revision: userRevision, action: 'import_user' }));
      this.setMeta(META_USER_REVISION, userRevision);
    });
    return { imported: true, official: (official.guides || []).length, user: userGuides.length };
  }

  // ---- 官方内容（含正文，仅管理端使用） ----
  getOfficialContent() {
    const guides = this.db.prepare("SELECT * FROM guides WHERE kind = 'official' ORDER BY sort_order ASC, id ASC").all().map(r => this.rowToGuide(r, true));
    const updates = this.db.prepare('SELECT date, title, summary FROM updates ORDER BY sort_order ASC, id ASC').all().map(r => ({ date: r.date, title: r.title, summary: r.summary }));
    return { guides: guides, updates: updates };
  }
  listUpdates() {
    return this.db.prepare('SELECT date, title, summary FROM updates ORDER BY sort_order ASC, id ASC').all().map(r => ({ date: r.date, title: r.title, summary: r.summary }));
  }
  replaceOfficialContent(content) {
    const guides = (content && Array.isArray(content.guides)) ? content.guides : [];
    const updates = (content && Array.isArray(content.updates)) ? content.updates : [];
    return this.tx(() => {
      const revision = this.getOfficialRevision() + 1;
      this.db.prepare("DELETE FROM guides WHERE kind = 'official'").run();
      this.db.prepare('DELETE FROM updates').run();
      guides.forEach((g, i) => {
        this.insertGuideRow(Object.assign({}, g, { kind: 'official', status: 'published' }), { kind: 'official', status: 'published', sortOrder: i, revision: revision, action: 'official_save' });
      });
      const insUpdate = this.db.prepare('INSERT INTO updates (date, title, summary, sort_order) VALUES (?, ?, ?, ?)');
      updates.forEach((u, i) => insUpdate.run(u.date, u.title, u.summary, i));
      this.setMeta(META_OFFICIAL_REVISION, revision);
      this.setMeta(META_OFFICIAL_UPDATED_AT, nowIso());
      return revision;
    });
  }

  // ---- 查询 ----
  getGuide(id, opts) {
    const o = opts || {};
    const row = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(String(id || ''));
    if (!row) return null;
    if (!o.includeDeleted && row.deleted_at) return null;
    return this.rowToGuide(row, o.withSections !== false);
  }
  getPublicGuide(id) {
    const row = this.db.prepare("SELECT * FROM guides WHERE id = ? AND deleted_at IS NULL AND (kind = 'official' OR (kind = 'user' AND status = 'approved'))").get(String(id || ''));
    return row ? this.rowToGuide(row, true) : null;
  }
  buildPublicWhere(o) {
    const where = ["g.deleted_at IS NULL", "(g.kind = 'official' OR (g.kind = 'user' AND g.status = 'approved'))"];
    const args = [];
    if (o.kind) { where.push('g.kind = ?'); args.push(o.kind); }
    if (o.category) { where.push('g.category = ?'); args.push(o.category); }
    if (o.q) {
      const like = likePattern(o.q);
      where.push("(g.title LIKE ? ESCAPE '\\' OR g.summary LIKE ? ESCAPE '\\' OR g.tags_json LIKE ? ESCAPE '\\' OR g.aliases_json LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM guide_sections s WHERE s.guide_id = g.id AND (s.heading LIKE ? ESCAPE '\\' OR COALESCE(s.text, '') LIKE ? ESCAPE '\\' OR COALESCE(s.items_json, '') LIKE ? ESCAPE '\\')))");
      for (let i = 0; i < 7; i++) args.push(like);
    }
    return { where: where, args: args };
  }
  listPublicGuides(opts) {
    const o = opts || {};
    const built = this.buildPublicWhere(o);
    const whereSql = built.where.join(' AND ');
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM guides g WHERE ' + whereSql).get(...built.args).n;
    const sql = 'SELECT g.* FROM guides g WHERE ' + whereSql + " ORDER BY CASE WHEN g.kind = 'official' THEN 0 ELSE 1 END, g.sort_order ASC, g.created_at ASC, g.id ASC";
    let rows;
    if (o.limit) {
      const limit = Math.max(1, Math.min(100000, intOr(o.limit, 50)));
      const offset = Math.max(0, intOr(o.offset, 0));
      rows = this.db.prepare(sql + ' LIMIT ? OFFSET ?').all(...built.args, limit, offset);
    } else {
      rows = this.db.prepare(sql).all(...built.args);
    }
    return { total: total, items: rows.map(r => this.rowToGuide(r, !!o.withSections)) };
  }
  listGuides(opts) {
    const o = opts || {};
    const where = [];
    const args = [];
    if (o.kind) { where.push('kind = ?'); args.push(o.kind); }
    if (o.status) { where.push('status = ?'); args.push(o.status); }
    if (o.authorKey) { where.push('author_key = ?'); args.push(o.authorKey); }
    if (!o.includeDeleted) where.push('deleted_at IS NULL');
    if (o.q) {
      const like = likePattern(o.q);
      where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM guide_sections s WHERE s.guide_id = guides.id AND (s.heading LIKE ? ESCAPE '\\' OR COALESCE(s.text, '') LIKE ? ESCAPE '\\' OR COALESCE(s.items_json, '') LIKE ? ESCAPE '\\')))");
      for (let i = 0; i < 6; i++) args.push(like);
    }
    const whereSql = where.length ? (' WHERE ' + where.join(' AND ')) : '';
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM guides' + whereSql).get(...args).n;
    const sql = 'SELECT * FROM guides' + whereSql + " ORDER BY CASE WHEN kind = 'official' THEN 0 ELSE 1 END, sort_order ASC, created_at ASC, id ASC";
    let rows;
    if (o.page && o.pageSize) {
      const page = Math.max(1, intOr(o.page, 1));
      const pageSize = Math.max(1, Math.min(200, intOr(o.pageSize, 20)));
      rows = this.db.prepare(sql + ' LIMIT ? OFFSET ?').all(...args, pageSize, (page - 1) * pageSize);
    } else {
      rows = this.db.prepare(sql).all(...args);
    }
    return { total: total, items: rows.map(r => this.rowToGuide(r, o.withSections !== false)) };
  }
  guideCounts() {
    const out = { official: 0, pending: 0, approved: 0, rejected: 0, deleted: 0 };
    this.db.prepare("SELECT kind, status, COUNT(*) AS n FROM guides WHERE deleted_at IS NULL GROUP BY kind, status").all().forEach(function (r) {
      if (r.kind === 'official') out.official = r.n;
      else if (out[r.status] != null) out[r.status] = r.n;
    });
    out.deleted = this.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE kind = 'user' AND deleted_at IS NOT NULL").get().n;
    return out;
  }
  countUserGuides() { return this.db.prepare("SELECT COUNT(*) AS n FROM guides WHERE kind = 'user'").get().n; }
  userGuideLimits(key) {
    const rows = this.db.prepare("SELECT status, submitted_at FROM guides WHERE kind = 'user' AND author_key = ? AND deleted_at IS NULL").all(String(key));
    const now = Date.now();
    const submittedIn24h = rows.filter(r => new Date(r.submitted_at).getTime() > now - 24 * 3600 * 1000).length;
    const pending = rows.filter(r => r.status === 'pending').length;
    let nextAllowedAt = null;
    rows.forEach(function (r) {
      const at = new Date(r.submitted_at).getTime() + 10 * 60 * 1000;
      if (at > now && (!nextAllowedAt || at < nextAllowedAt)) nextAllowedAt = at;
    });
    return { submittedIn24h: submittedIn24h, pending: pending, nextAllowedAt: nextAllowedAt ? new Date(nextAllowedAt).toISOString() : null };
  }

  // ---- 玩家投稿写入 ----
  insertUserGuide(g) {
    if (this.countUserGuides() >= MAX_USER_GUIDES) return { error: '投稿总量已达上限（' + MAX_USER_GUIDES + ' 篇），请联系管理员清理' };
    const userRevision = this.getUserRevision() + 1;
    return this.tx(() => {
      this.insertGuideRow(g, { kind: 'user', revision: 1, action: g.status === 'approved' ? 'auto_approve' : 'submit' });
      this.setMeta(META_USER_REVISION, userRevision);
      return { revision: userRevision };
    });
  }
  reviewGuide(id, status, actorKey, actorName, note) {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM guides WHERE id = ? AND kind = 'user' AND deleted_at IS NULL").get(String(id));
      if (!row) return null;
      const userRevision = this.getUserRevision() + 1;
      const now = nowIso();
      this.db.prepare('UPDATE guides SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(status, now, actorKey || null, note || '', now, String(id));
      this.setMeta(META_USER_REVISION, userRevision);
      const updated = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(String(id));
      this.writeRevision(id, intOr(row.revision, 1) + 1, status === 'approved' ? 'approve' : 'reject', actorKey, actorName, this.rowToGuide(updated, true));
      return userRevision;
    });
  }
  softDeleteGuide(id, actorKey, actorName, reason) {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM guides WHERE id = ? AND kind = 'user' AND deleted_at IS NULL").get(String(id));
      if (!row) return null;
      const userRevision = this.getUserRevision() + 1;
      const now = nowIso();
      this.db.prepare('UPDATE guides SET deleted_at = ?, deleted_by = ?, delete_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(now, actorKey || null, reason || '', now, String(id));
      this.setMeta(META_USER_REVISION, userRevision);
      const updated = this.db.prepare('SELECT * FROM guides WHERE id = ?').get(String(id));
      this.writeRevision(id, intOr(row.revision, 1) + 1, 'delete', actorKey, actorName, this.rowToGuide(updated, true));
      return userRevision;
    });
  }
}

module.exports = WikiStore;
module.exports.WikiStore = WikiStore;
module.exports.MAX_USER_GUIDES = MAX_USER_GUIDES;
