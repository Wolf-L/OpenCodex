const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeFileAtomicSync, writeJsonAtomicSync } = require("../../shared/atomic-file.cjs");
const { replaceAuthPasswordScalar, findAuthPasswordScalar } = require("../../shared/auth-config.cjs");

test("password edits preserve unrelated YAML, comments and CRLF", () => {
  const before = '# settings\r\nserver:\r\n  port: 4567\r\nauth: # access\r\n  password: "old#secret" # keep\r\n  limit: 3\r\nplugins:\r\n  - hello\r\n';
  const after = replaceAuthPasswordScalar(before, "sha256-v1:fixture");
  assert.equal(after, before.replace('"old#secret"', '"sha256-v1:fixture"'));
  assert.equal(findAuthPasswordScalar(after).value, "sha256-v1:fixture");
});
test("missing auth and missing password are added without discarding data", () => {
  assert.equal(replaceAuthPasswordScalar('other: yes', ''), 'other: yes\nauth:\n  password: ""\n');
  assert.equal(replaceAuthPasswordScalar('auth:\n    attempts: 5\nother: yes\n', 'x'), 'auth:\n    password: "x"\n    attempts: 5\nother: yes\n');
});
for (const raw of ['auth: {password: old}', 'auth:\n  password: old\nauth:\n  password: other', 'auth:\n  password: a\n  password: b', 'auth:\n  password: |\n    multiline', 'auth:\n  password: "broken', '"auth":\n  password: old', 'auth:\n  <<: *old', '---\nauth:\n  password: old']) {
  test(`ambiguous config is refused: ${JSON.stringify(raw)}`, () => assert.throws(() => replaceAuthPasswordScalar(raw, 'new')));
}
test("atomic rename failure leaves original bytes and cleans temporary file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.yaml');
  fs.writeFileSync(file, 'original');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('injected rename failure'); };
  try { assert.throws(() => writeFileAtomicSync(file, 'changed'), /injected/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['config.yaml']);
});
test("atomic settings fsync and preserve permissions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencodex-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const sync = fs.fsyncSync;
  let count = 0;
  fs.fsyncSync = (...args) => { count++; return sync(...args); };
  try { writeJsonAtomicSync(file, { hello: true }); }
  finally { fs.fsyncSync = sync; }
  assert.equal(count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { hello: true });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o640);
    writeJsonAtomicSync(file, { next: true });
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  }
});
