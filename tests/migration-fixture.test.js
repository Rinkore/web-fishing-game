'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(ROOT, 'tools/go-rewrite/migration-fixture.js');

function generate(parent, variant) {
  const target = path.join(parent, `snapshot-${variant}`);
  const output = execFileSync(process.execPath, [GENERATOR, '--output', target, '--variant', variant], { cwd: ROOT, encoding: 'utf8' });
  return { target, output: JSON.parse(output), manifest: JSON.parse(fs.readFileSync(`${target}.manifest.json`, 'utf8')), oracle: JSON.parse(fs.readFileSync(`${target}.oracle.json`, 'utf8')) };
}

test('synthetic valid fixture keeps JSON and Wiki SQLite counts aligned', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-migration-fixture-'));
  try {
    const fixture = generate(temp, 'valid');
    assert.equal(fixture.output.fileCount, 14);
    assert.equal(fixture.manifest.files.length, 14);
    assert.equal(fixture.oracle.sourceVersion, 'v0.21.4');
    assert.deepEqual(fixture.oracle.requiredChecks, [
      'old-id-map-preserved', 'coins-and-quantities-exact', 'escrow-owner-and-quantity',
      'trade-state-preserved', 'wiki-json-sqlite-consistent', 'sessions-revoked-before-cutover',
      'unknown-fields-abort-import',
    ]);
    const wikiJson = JSON.parse(fs.readFileSync(path.join(fixture.target, 'wiki.json'), 'utf8'));
    const userJson = JSON.parse(fs.readFileSync(path.join(fixture.target, 'wiki-guides.json'), 'utf8'));
    // Run SQLite verification in a child process. Node's experimental SQLite
    // bindings can retain prepared statements until GC on Windows, which
    // would otherwise keep the temporary fixture directory undeletable.
    const dbProbe = [
      "const {DatabaseSync}=require('node:sqlite');",
      "const db=new DatabaseSync(process.argv[1]);",
      "const guides=db.prepare('SELECT id,kind,status,title,category,summary,revision FROM guides ORDER BY id').all();",
      "const sections=db.prepare('SELECT guide_id,heading,type,text FROM guide_sections ORDER BY guide_id,ord').all();",
      "const updates=db.prepare('SELECT date,title,summary FROM updates ORDER BY sort_order').all();",
      "const out={guides,sections,updates,officialRevision:db.prepare(\"SELECT value FROM wiki_meta WHERE key='official_revision'\").get().value};",
      "console.log(JSON.stringify(out)); db.close();",
    ].join('');
    const dbData = JSON.parse(execFileSync(process.execPath, ['-e', dbProbe, path.join(fixture.target, 'wiki.db')], { cwd: ROOT, encoding: 'utf8' }));
    assert.equal(dbData.guides.filter(row => row.kind === 'official').length, wikiJson.wikiContent.guides.length);
    assert.equal(dbData.guides.filter(row => row.kind === 'user').length, userJson.wikiUserGuides.length);
    assert.equal(dbData.updates.length, wikiJson.wikiContent.updates.length);
    assert.equal(dbData.sections.length, 2);
    assert.equal(dbData.officialRevision, String(wikiJson.wikiContentRevision));
    for (const [kind, guides] of [['official', wikiJson.wikiContent.guides], ['user', userJson.wikiUserGuides]]) {
      for (const guide of guides) {
        const row = dbData.guides.find(candidate => candidate.id === guide.id);
        assert.deepEqual(row, { id: guide.id, kind, status: guide.status, title: guide.title, category: guide.category, summary: guide.summary, revision: guide.revision });
        const sections = dbData.sections.filter(section => section.guide_id === guide.id);
        assert.equal(sections.length, guide.sections.length);
        guide.sections.forEach((section, index) => {
          assert.equal(sections[index].heading, section.h);
          assert.equal(sections[index].type, section.type);
          assert.equal(sections[index].text, section.text || null);
        });
      }
    }
    for (const entry of fixture.manifest.files) {
      const bytes = fs.readFileSync(path.join(fixture.target, entry.path));
      assert.equal(bytes.length, entry.bytes, entry.path);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  }
});

test('blocked fixture is explicit and adds monolith/unknown domains', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-migration-fixture-blocked-'));
  try {
    const fixture = generate(temp, 'blocked');
    assert.equal(fixture.output.fileCount, 16);
    assert.equal(fixture.manifest.variant, 'blocked');
    assert.ok(fixture.manifest.files.some(file => file.path === 'users.json'));
    assert.ok(fixture.manifest.files.some(file => file.path === 'unclassified-future.json'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  }
});
