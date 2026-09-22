'use strict';

// Builds the Wiki snapshot that the Go gateway embeds. The source of truth is
// frontend/wiki/content/content.json — the same file the legacy server imports
// into wiki.db. Keeping a generated snapshot (with the source digest) makes the
// Go build hermetic and lets CI fail when the source changes without a reviewed
// regeneration. Field validation mirrors normalizeWikiContent in
// backend/server.js; unknown section types are rejected instead of dropped.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = path.resolve(__dirname, '../../frontend/wiki/content/content.json');
const output = path.resolve(__dirname, '../../server-go/internal/wiki/content.json');
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { guides: 100, updates: 100, sections: 40, heading: 100, text: 5000, items: 30, item: 1500 };

function reject(message) { throw new Error('Wiki source rejected: ' + message); }

function text(value, max, required) {
  if (value === undefined || value === null || value === '') return required ? null : '';
  if (typeof value !== 'string') return null;
  const out = value.trim();
  if (!out || out.length > max) return null;
  return out;
}

function stringList(value, maxItems, maxLen) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > maxLen) return null;
    out.push(trimmed);
  }
  return out;
}

function sectionOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('guide section must be an object');
  const heading = text(raw.h, LIMITS.heading, true);
  if (!heading) reject('guide section heading missing or too long');
  if (raw.type === 'p' || raw.type === 'note') {
    const body = text(raw.text, LIMITS.text, true);
    if (!body) reject('guide paragraph text missing or too long');
    return { h: heading, type: raw.type, text: body };
  }
  if (raw.type === 'ol' || raw.type === 'ul') {
    const items = stringList(raw.items, LIMITS.items, LIMITS.item);
    if (!items || !items.length) reject('guide list items missing or too long');
    return { h: heading, type: raw.type, items: items };
  }
  return reject('unknown guide section type: ' + String(raw.type));
}

function guideOf(raw, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('official guide must be an object');
  if (raw.author != null || raw.authorKey != null || raw.submittedAt != null) reject('official guide carries user-submission fields');
  const id = text(raw.id, 80, true);
  const title = text(raw.title, 120, true);
  const category = text(raw.category, 40, true);
  const summary = text(raw.summary, 300, true);
  const updatedAt = text(raw.updatedAt, 10, true);
  if (!id || !ID_PATTERN.test(id)) reject('guide id must be lowercase letters, digits and dashes: ' + String(raw.id));
  if (seen.has(id)) reject('duplicate guide id: ' + id);
  if (!title || !category || !summary || !DATE_PATTERN.test(updatedAt || '')) reject('guide title, category, summary or date invalid: ' + id);
  const aliases = stringList(raw.aliases, 16, 40);
  const tags = stringList(raw.tags, 16, 24);
  if (!aliases || !tags) reject('guide aliases or tags invalid: ' + id);
  if (!Array.isArray(raw.sections) || !raw.sections.length || raw.sections.length > LIMITS.sections) {
    reject('guide sections must hold 1-' + LIMITS.sections + ' entries: ' + id);
  }
  seen.add(id);
  return {
    id: id, kind: 'official', status: 'published', title: title, category: category,
    aliases: aliases, tags: tags, updatedAt: updatedAt, summary: summary,
    sections: raw.sections.map(sectionOf),
  };
}

function updateOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('update record must be an object');
  const date = text(raw.date, 10, true);
  const title = text(raw.title, 120, true);
  const summary = text(raw.summary, 500, true);
  if (!date || !DATE_PATTERN.test(date) || !title || !summary) reject('update record date, title or summary invalid');
  return { date: date, title: title, summary: summary };
}

function build() {
  const rawSource = fs.readFileSync(source, 'utf8');
  const parsed = JSON.parse(rawSource);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) reject('content root must be an object');
  if (!Array.isArray(parsed.guides) || !parsed.guides.length) reject('at least one official guide is required');
  if (parsed.guides.length > LIMITS.guides) reject('too many official guides');
  if (!Array.isArray(parsed.updates)) reject('updates must be an array');
  if (parsed.updates.length > LIMITS.updates) reject('too many update records');
  const seen = new Set();
  const guides = parsed.guides.map(function (raw) { return guideOf(raw, seen); });
  const updates = parsed.updates.map(updateOf);
  return {
    format: 1,
    source: 'frontend/wiki/content/content.json',
    sourceSHA256: crypto.createHash('sha256').update(rawSource.replace(/\r\n/g, '\n')).digest('hex'),
    guides: guides,
    updates: updates,
  };
}

const snapshot = build();
const content = JSON.stringify(snapshot, null, 2) + '\n';
if (process.argv[2] === '--write') {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);
} else if (process.argv[2] === '--check') {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== content) {
    throw new Error('Go Wiki snapshot is stale; review the source change before --write');
  }
} else throw new Error('Usage: node tools/go-rewrite/wiki-content.js --write|--check');
console.log('Wiki content: ' + snapshot.guides.length + ' guides, ' + snapshot.updates.length +
  ' updates, source ' + snapshot.sourceSHA256.slice(0, 12));
