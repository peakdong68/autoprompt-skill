'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const test = require('node:test')
const packaging = require('../../scripts/harness-v2-package.cjs')
const settings = require('../../scripts/install/prime-settings.cjs')
const legacy = require('../../scripts/install/harness-v2-legacy.json').providers.prime

function fixture(t, settingsBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-v2-registration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const relative = 'autoprompt/packages/prime/package.json'
  const packageFile = path.join(root, relative)
  const bytes = fs.readFileSync(path.join(packaging.ROOT, 'agents/prime/package.json'))
  assert.ok(legacy[relative].includes(crypto.createHash('sha256').update(bytes).digest('hex')), 'fixture must be byte-matched legacy metadata')
  fs.mkdirSync(path.dirname(packageFile), { recursive: true }); fs.writeFileSync(packageFile, bytes)
  const packageRoot = path.dirname(packageFile)
  const file = path.join(root, 'settings.json')
  const original = settingsBytes ? settingsBytes(packageRoot) : Buffer.from(JSON.stringify({ packages: [packageRoot, 'custom-package'], rlmMaxDepth: 3 }))
  fs.writeFileSync(file, original, { mode: 0o640 })
  return { root, relative, packageFile, packageRoot, bytes, file, original }
}

test('Prime migration retires only the managed registration and retains exact original settings privately', t => {
  const f = fixture(t, packageRoot => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([
    '{', '  // User comments and CRLF must survive.', '  "packages": [',
    `    ${JSON.stringify(packageRoot)},`, '    "custom-package",',
    '    "./autoprompt/packages/prime",',
    `    { "source": ${JSON.stringify(packageRoot)}, "extensions": ["managed-selection"] },`,
    '    { "source": "../personal-package", "extensions": ["keep-this"] },', '  ],',
    '  "rlmMaxDepth": 3,', '  "theme": "personal-theme",', '}', '',
  ].join('\r\n'))]))
  const installed = packaging.install('prime', f.root)
  const current = fs.readFileSync(f.file)
  const parsed = settings.inspect(current, f.packageRoot, f.root)
  assert.equal(parsed.packageMatches.length, 0, 'quarantined code must not remain registered in Prime')
  assert.deepEqual(parsed.packages, ['custom-package', { source: '../personal-package', extensions: ['keep-this'] }])
  assert.equal(parsed.depth, 3); assert.equal(parsed.parsed.value.theme, 'personal-theme')
  assert.equal(current.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true)
  assert.ok(current.toString().includes('// User comments and CRLF must survive.\r\n'))
  assert.deepEqual(fs.readFileSync(installed.legacySettingsBackup), f.original)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o640)
    assert.equal(fs.statSync(path.dirname(installed.legacySettingsBackup)).mode & 0o077, 0)
  }
  assert.equal(fs.existsSync(f.packageFile), false)
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.autoprompt-private/legacy-v1/prime', f.relative)), f.bytes)
  packaging.uninstall('prime', f.root)
  assert.deepEqual(fs.readFileSync(f.file), current, 'uninstall must not re-register retired code')
  assert.deepEqual(fs.readFileSync(installed.legacySettingsBackup), f.original)
})

test('unrelated Prime packages, comments and settings remain byte-identical', t => {
  const f = fixture(t, () => Buffer.from('{ // preserve\n "packages": ["custom-package"], "rlmMaxDepth": 8,\n}\n'))
  const installed = packaging.install('prime', f.root)
  assert.deepEqual(fs.readFileSync(f.file), f.original)
  assert.equal(installed.legacySettingsBackup, undefined)
  packaging.uninstall('prime', f.root)
  assert.deepEqual(fs.readFileSync(f.file), f.original)
})

test('malformed registered legacy settings refuse migration before removing any native package bytes', t => {
  for (const text of ['{ broken JSONC', '{"packages":"not-an-array"}']) {
    const f = fixture(t, () => Buffer.from(text))
    assert.throws(() => packaging.install('prime', f.root), { code: 'INSTALL_CONFLICT' })
    assert.deepEqual(fs.readFileSync(f.file), f.original)
    assert.deepEqual(fs.readFileSync(f.packageFile), f.bytes)
    assert.equal(fs.existsSync(path.join(f.root, packaging.receiptName('prime'))), false)
  }
})

test('receipt publication failure restores both the original Prime registration and package', t => {
  const f = fixture(t)
  const rename = fs.renameSync
  const intercepted = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.root, packaging.receiptName('prime'))) throw Object.assign(new Error('receipt publication failed'), { code: 'EIO' })
    return rename(from, to)
  })
  assert.throws(() => packaging.install('prime', f.root), { code: 'EIO' })
  intercepted.mock.restore()
  assert.deepEqual(fs.readFileSync(f.file), f.original)
  assert.deepEqual(fs.readFileSync(f.packageFile), f.bytes)
  assert.equal(fs.existsSync(path.join(f.root, packaging.receiptName('prime'))), false)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o640)
  const retried = packaging.install('prime', f.root)
  assert.equal(settings.inspect(fs.readFileSync(f.file), f.packageRoot, f.root).packageMatches.length, 0)
  assert.deepEqual(fs.readFileSync(retried.legacySettingsBackup), f.original)
})

test('a recognized already-quarantined Prime package can have its stale registration repaired', t => {
  const f = fixture(t)
  const quarantined = path.join(f.root, '.autoprompt-private/legacy-v1/prime', f.relative)
  fs.mkdirSync(path.dirname(quarantined), { recursive: true, mode: 0o700 })
  fs.renameSync(f.packageFile, quarantined)
  const installed = packaging.install('prime', f.root)
  assert.equal(settings.inspect(fs.readFileSync(f.file), f.packageRoot, f.root).packageMatches.length, 0)
  assert.deepEqual(fs.readFileSync(installed.legacySettingsBackup), f.original)
  assert.deepEqual(fs.readFileSync(quarantined), f.bytes)
})

test('settings edited after migration planning are not overwritten', t => {
  const f = fixture(t)
  const migration = require('../../scripts/harness-v2-prime-migration.cjs')
  const planned = migration.plan('prime', f.root, [{ file: f.packageFile }], legacy)
  const changed = Buffer.from('{"packages":["new-user-package"],"theme":"new-theme"}')
  fs.writeFileSync(f.file, changed)
  let calls = 0
  assert.throws(() => migration.apply(planned, { put() { calls++ }, move() { calls++ } }), { code: 'INSTALL_CONFLICT' })
  assert.equal(calls, 0)
  assert.deepEqual(fs.readFileSync(f.file), changed)
  assert.deepEqual(fs.readFileSync(f.packageFile), f.bytes)
})

test('idempotent Prime installation repairs a recognized stale registration without replacing its runtime', t => {
  const f = fixture(t)
  const installed = packaging.install('prime', f.root)
  // Reproduce an older install that quarantined managed code but retained its registration.
  fs.writeFileSync(f.file, f.original)
  const repaired = packaging.install('prime', f.root)
  assert.equal(repaired.payloadGeneration, installed.payloadGeneration)
  assert.equal(settings.inspect(fs.readFileSync(f.file), f.packageRoot, f.root).packageMatches.length, 0)
  assert.deepEqual(fs.readFileSync(repaired.legacySettingsBackup), f.original)
  assert.equal(packaging.verify('prime', f.root).payloadGeneration, installed.payloadGeneration)
})

test('linked Prime settings cannot rewrite another configuration during migration', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const outside = path.join(f.root, 'personal-settings.json')
  fs.renameSync(f.file, outside)
  fs.symlinkSync(outside, f.file)
  assert.throws(() => packaging.install('prime', f.root))
  assert.deepEqual(fs.readFileSync(outside), f.original)
  assert.deepEqual(fs.readFileSync(f.packageFile), f.bytes)
  assert.equal(fs.existsSync(path.join(f.root, packaging.receiptName('prime'))), false)
})
