import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';

test('offline source upload inventory matches narrow allowlist and contains regular source files', async () => {
  const rules = (await readFile(new URL('../.gcloudignore', import.meta.url), 'utf8'))
    .split('\n').filter(line => line && !line.startsWith('#'));
  assert.deepEqual(rules, ['*', '!Dockerfile', '!package.json', '!LICENSE', '!NOTICE', '!src/', '!src/*.mjs']);
  const source = await readdir(new URL('../src/', import.meta.url));
  assert.ok(source.length > 0);
  for (const name of source) {
    assert.match(name, /^[a-z-]+\.mjs$/);
    assert.ok((await lstat(new URL(`../src/${name}`, import.meta.url))).isFile());
  }
  for (const name of ['Dockerfile', 'package.json', 'LICENSE', 'NOTICE'])
    assert.ok((await lstat(new URL(`../${name}`, import.meta.url))).isFile());
  // This checks this small rule subset offline, not the real gcloud CLI parser.
  const included = path => ['Dockerfile', 'package.json', 'LICENSE', 'NOTICE'].includes(path)
    || /^src\/[a-z-]+\.mjs$/.test(path);
  for (const path of ['.env', '.git/config', 'auth.json', 'evidence.log', 'state.db', 'src/nested/state.db', 'test/core.test.mjs'])
    assert.equal(included(path), false);
  const docker = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.ok(docker.startsWith('*\n'));
  assert.ok(!docker.includes('!test/'));
});
