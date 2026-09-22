// Offline integration tests: every push targets an isolated temporary bare repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const entrypoint = path.resolve(__dirname, '../tools/release/start-release.ps1');
const pwsh = process.env.FISHING_TEST_PWSH || 'pwsh';

function run(command, args, cwd, env, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (!allowFailure) assert.equal(result.status, 0, `${command} ${args[0]} failed:\n${output}`);
  return { status: result.status, output: output.trim(), stdout: (result.stdout || '').trim() };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const repo = path.join(root, 'checkout');
  const remote = path.join(root, 'origin.git');
  const emptyConfig = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0' };
  fs.mkdirSync(repo);
  const git = (...args) => run('git', args, repo, env).stdout;
  const remoteGit = (...args) => run('git', ['--git-dir', remote, ...args], repo, env).stdout;
  run('git', ['init', '--bare', remote], root, env);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'tools/release'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'frontend/js'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  fs.copyFileSync(entrypoint, path.join(repo, 'tools/release/start-release.ps1'));
  function writeVersion(version, notesVersion = version) {
    fs.writeFileSync(path.join(repo, 'frontend/js/data.js'), `const VERSION = '${version}';\n`);
    fs.writeFileSync(path.join(repo, 'dist', `notes-${version}.md`), `# ${notesVersion} · Integration test / Release\n\nTest notes.\n`);
  }
  function commit(message = 'prepare release') {
    git('add', '.');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  writeVersion('v0.21.4');
  const base = commit('initial release');
  git('tag', '-a', 'v0.21.4', '-m', 'Previous release');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main', 'refs/tags/v0.21.4');
  function start(...args) {
    return run(pwsh, ['-NoLogo', '-NoProfile', '-File', path.join(repo, 'tools/release/start-release.ps1'), ...args], repo, env, true);
  }
  return { root, repo, remote, env, git, remoteGit, writeVersion, commit, base, start };
}

test('default check derives source version and leaves local and remote refs unchanged', t => {
  const f = fixture(t);
  f.writeVersion('v0.21.5');
  f.commit();
  const before = f.remoteGit('show-ref');
  const result = f.start();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Validated v0\.21\.5/);
  assert.match(result.output, /Check only/);
  assert.equal(f.remoteGit('show-ref'), before);
  assert.equal(f.git('tag', '--list', 'v0.21.5'), '');
});

test('publish atomically pushes main and an annotated tag; retry creates no event', t => {
  const f = fixture(t);
  f.writeVersion('v0.21.5');
  const head = f.commit();
  f.git('tag', '-a', 'local-only', '-m', 'Do not publish this unrelated tag');
  f.git('config', 'push.followTags', 'true');
  const first = f.start('-Publish');
  assert.equal(first.status, 0, first.output);
  assert.equal(f.remoteGit('rev-parse', 'refs/heads/main'), head);
  assert.equal(f.remoteGit('rev-parse', 'refs/tags/v0.21.5^{commit}'), head);
  assert.equal(f.remoteGit('cat-file', '-t', 'refs/tags/v0.21.5'), 'tag');
  assert.equal(f.remoteGit('tag', '--list', 'local-only'), '');
  assert.match(f.remoteGit('cat-file', '-p', 'refs/tags/v0.21.5'), /\ntag v0\.21\.5\n/);
  assert.equal(f.git('rev-parse', 'refs/tags/v0.21.5'), f.remoteGit('rev-parse', 'refs/tags/v0.21.5'));
  const before = f.remoteGit('show-ref');
  const retry = f.start('-Publish');
  assert.equal(retry.status, 0, retry.output);
  assert.match(retry.output, /no new tag event created/);
  assert.match(retry.output, /workflow_dispatch/);
  assert.equal(f.remoteGit('show-ref'), before);
});

test('same-version revision requires explicit intent and updates latest annotated tag', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.repo, 'dist/notes-v0.21.4.md'), 'Revision details.\n');
  const head = f.commit('same version fix');
  const previousTag = f.remoteGit('rev-parse', 'refs/tags/v0.21.4');
  const denied = f.start('-Publish');
  assert.notEqual(denied.status, 0);
  assert.match(denied.output, /SameVersionRevision/);
  assert.equal(f.remoteGit('rev-parse', 'refs/heads/main'), f.base);
  const result = f.start('-Publish', '-SameVersionRevision');
  assert.equal(result.status, 0, result.output);
  assert.equal(f.remoteGit('rev-parse', 'refs/heads/main'), head);
  assert.equal(f.remoteGit('rev-parse', 'refs/tags/v0.21.4^{commit}'), head);
  assert.notEqual(f.remoteGit('rev-parse', 'refs/tags/v0.21.4'), previousTag);
});

test('a remote rejection cannot update main or create a local release tag', t => {
  const f = fixture(t);
  f.writeVersion('v0.21.5');
  f.commit();
  const hook = path.join(f.remote, 'hooks/pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/tags/*) echo "release denied for test" >&2; exit 1;; esac\ndone\n');
  fs.chmodSync(hook, 0o755);
  const before = f.remoteGit('show-ref');
  const result = f.start('-Publish');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /release denied for test/);
  assert.equal(f.remoteGit('show-ref'), before);
  assert.equal(f.git('tag', '--list', 'v0.21.5'), '');
});

test('same-version push uses an exact old tag lease against a concurrent tag update', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.repo, 'dist/notes-v0.21.4.md'), 'Revision details.\n');
  f.commit('same version fix');
  f.git('tag', '-a', 'race-replacement', '-m', 'Concurrent publisher');
  f.git('push', 'origin', 'refs/tags/race-replacement');
  const replacement = f.remoteGit('rev-parse', 'refs/tags/race-replacement');
  // The local pre-push hook runs after ls-remote validation but before updates.
  const hook = path.join(f.repo, '.git/hooks/pre-push');
  const posixRemote = f.remote.replaceAll('\\', '/').replaceAll("'", "'\\''");
  fs.writeFileSync(hook, `#!/bin/sh\ngit --git-dir='${posixRemote}' update-ref refs/tags/v0.21.4 ${replacement}\n`);
  fs.chmodSync(hook, 0o755);
  const oldLocal = f.git('rev-parse', 'refs/tags/v0.21.4');
  const result = f.start('-Publish', '-SameVersionRevision');
  assert.notEqual(result.status, 0, result.output);
  assert.equal(f.remoteGit('rev-parse', 'refs/heads/main'), f.base);
  assert.equal(f.remoteGit('rev-parse', 'refs/tags/v0.21.4'), replacement);
  assert.equal(f.git('rev-parse', 'refs/tags/v0.21.4'), oldLocal);
});

test('dirty worktree and non-main branch are rejected before publication', t => {
  const f = fixture(t);
  const before = f.remoteGit('show-ref');
  fs.writeFileSync(path.join(f.repo, 'unreviewed.txt'), 'not a release');
  const dirty = f.start('-Publish');
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.output, /Working tree is dirty/);
  fs.unlinkSync(path.join(f.repo, 'unreviewed.txt'));
  f.git('switch', '-c', 'feature');
  const branch = f.start('-Publish');
  assert.notEqual(branch.status, 0);
  assert.match(branch.output, /main branch/);
  assert.equal(f.remoteGit('show-ref'), before);
});

test('version, note mismatch, skipped versions and invalid revision flags are rejected', t => {
  const f = fixture(t);
  const before = f.remoteGit('show-ref');
  f.writeVersion('v0.21.5');
  f.commit();
  const mismatch = f.start('-Publish', '-Version', 'v0.21.6');
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.output, /does not match/);
  const newRevision = f.start('-Publish', '-SameVersionRevision');
  assert.notEqual(newRevision.status, 0);
  assert.match(newRevision.output, /requires an existing latest release tag/);
  f.writeVersion('v0.21.5', 'v0.21.4');
  f.commit('wrong notes');
  const notes = f.start('-Publish');
  assert.notEqual(notes.status, 0);
  assert.match(notes.output, /first line/);
  f.writeVersion('v0.21.7');
  f.commit('skip patch versions');
  const skipped = f.start('-Publish');
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.output, /without skipping/);
  assert.equal(f.remoteGit('show-ref'), before);
});

test('immediate minor and major releases are valid while nonlatest revisions are rejected', t => {
  const f = fixture(t);
  for (const version of ['v0.22.0', 'v1.0.0']) {
    f.writeVersion(version);
    f.commit(`prepare ${version}`);
    const result = f.start();
    assert.equal(result.status, 0, result.output);
  }
  f.git('tag', '-a', 'v0.22.0', '-m', 'Newer remote release');
  f.git('push', 'origin', 'refs/tags/v0.22.0');
  f.writeVersion('v0.21.4');
  f.commit('attempt old release revision');
  const result = f.start('-Publish', '-SameVersionRevision');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Only the latest release/);
  assert.equal(f.remoteGit('rev-parse', 'refs/heads/main'), f.base);
});

test('a freshly advanced origin/main is fetched and a divergent release is rejected', t => {
  const f = fixture(t);
  const other = path.join(f.root, 'another-checkout');
  run('git', ['clone', '-b', 'main', f.remote, other], f.root, f.env);
  run('git', ['config', 'user.name', 'Other Publisher'], other, f.env);
  run('git', ['config', 'user.email', 'other@example.invalid'], other, f.env);
  fs.writeFileSync(path.join(other, 'advance.txt'), 'remote advanced');
  run('git', ['add', '.'], other, f.env);
  run('git', ['commit', '-m', 'Advance main independently'], other, f.env);
  run('git', ['push', 'origin', 'main'], other, f.env);
  const remoteHead = f.remoteGit('rev-parse', 'refs/heads/main');
  f.writeVersion('v0.21.5');
  f.commit();
  const result = f.start('-Publish');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /HEAD does not contain origin\/main/);
  assert.equal(f.git('rev-parse', 'refs/remotes/origin/main'), remoteHead);
  assert.equal(f.remoteGit('rev-parse', 'refs/heads/main'), remoteHead);
  assert.equal(f.git('tag', '--list', 'v0.21.5'), '');
});
