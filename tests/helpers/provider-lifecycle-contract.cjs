'use strict'
// Source lifecycle regression helpers. No fake harness executes native work.
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const pkg = require('../../scripts/harness-v2-package.cjs')
const ROOT = path.resolve(__dirname, '../..')
function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-provider-regression-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, root: path.join(directory, 'custom config 雪') }
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
const original = require('./legacy-provider-fixture.cjs').readLegacyFixture
function snapshot(root) { return Object.fromEntries(pkg.walk(root).map(file => [file, fs.readFileSync(path.join(root, file)).toString('base64')])) }
function publicationFault(call, predicate) {
  const rename = fs.renameSync
  let injected = false
  fs.renameSync = (from, to) => {
    if (!injected && predicate(from, to)) { injected = true; throw new Error('test publication failure') }
    return rename(from, to)
  }
  try { assert.throws(call, /test publication failure/) } finally { fs.renameSync = rename }
  assert.equal(injected, true, 'fault must reach the actual publication boundary')
}
function legacySource(provider) {
  if (provider === 'prime') return ['autoprompt/packages/prime/personas/ap-manager.md', 'agents/prime/personas/ap-manager.md']
  if (provider === 'deepseek') return ['.agent-presets/autoprompt/agent.cordis.yml', 'agents/deepseek/agent-preset/agent.cordis.yml']
  const name = provider === 'vscode' ? 'ap-manager.agent.md' : 'ap-manager.md'
  return [`agents/${name}`, `agents/${provider}/agents/${name}`]
}
function registerProviderLifecycle(provider, configFiles) {
  test(`${provider}: v2 preserves native configuration byte-for-byte, including malformed and custom depth settings`, t => {
    const { root } = context(t)
    for (const [file, bytes] of Object.entries(configFiles)) write(path.join(root, file), bytes)
    const before = snapshot(root)
    const installed = pkg.install(provider, root)
    assert.equal(installed.contractVersion, '2.0.0')
    for (const [file, bytes] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, file)).toString('base64'), bytes, file)
    pkg.uninstall(provider, root)
    assert.deepEqual(snapshot(root), before)
  })
  test(`${provider}: public entry conflicts preserve the complete custom tree`, t => {
    const { root } = context(t)
    write(pkg.launcherPath(provider, root), 'user-owned launcher\n')
    write(path.join(root, 'custom/untouched'), 'custom')
    const before = snapshot(root)
    assert.throws(() => pkg.install(provider, root), /Unowned launcher|Changed legacy/)
    assert.deepEqual(snapshot(root), before)
  })
  test(`${provider}: reintroduced globally discoverable legacy roles invalidate a v2 receipt`, t => {
    const { root } = context(t)
    pkg.install(provider, root)
    const [relative] = legacySource(provider)
    write(path.join(root, relative), 'unregistered public role')
    const before = snapshot(root)
    for (const operation of [pkg.verify, pkg.install, pkg.uninstall]) assert.throws(() => operation(provider, root), /Legacy managed discovery remains/)
    assert.deepEqual(snapshot(root), before)
  })
  test(`${provider}: recognized historic bytes are quarantined and never restored to discovery on uninstall`, t => {
    const { root } = context(t)
    const [relative, source] = legacySource(provider)
    const bytes = original(source)
    const hashes = require('../../scripts/install/harness-v2-legacy.json').providers[provider][relative]
    assert.ok(hashes?.includes(crypto.createHash('sha256').update(bytes).digest('hex')), relative)
    write(path.join(root, relative), bytes)
    write(path.join(root, 'custom.txt'), 'preserve')
    const installed = pkg.install(provider, root)
    assert.ok(installed.migrated.includes(relative))
    const quarantine = path.join(root, '.autoprompt-private/legacy-v1', provider, relative)
    assert.deepEqual(fs.readFileSync(quarantine), bytes)
    assert.equal(fs.existsSync(path.join(root, relative)), false)
    pkg.uninstall(provider, root)
    assert.deepEqual(fs.readFileSync(quarantine), bytes)
    assert.equal(fs.existsSync(path.join(root, relative)), false)
    assert.equal(fs.readFileSync(path.join(root, 'custom.txt'), 'utf8'), 'preserve')
  })
  test(`${provider}: modified historical files refuse migration without losing user edits`, t => {
    const { root } = context(t)
    const [relative] = legacySource(provider)
    write(path.join(root, relative), 'modified historical role')
    const before = snapshot(root)
    assert.throws(() => pkg.install(provider, root), /Changed legacy file/)
    assert.deepEqual(snapshot(root), before)
  })
  test(`${provider}: failed uninstall restores its exact receipt, launcher, bundle and custom files`, t => {
    const { root } = context(t)
    pkg.install(provider, root)
    write(path.join(root, 'custom.txt'), 'preserve')
    const before = snapshot(root)
    publicationFault(() => pkg.uninstall(provider, root), from => from === path.join(root, pkg.receiptName(provider)))
    assert.deepEqual(snapshot(root), before)
    assert.equal(pkg.verify(provider, root).status, 'verified')
  })
  test(`${provider}: forged traversal receipts cannot delete outside or private custom data`, t => {
    const { root, directory } = context(t)
    pkg.install(provider, root)
    const outside = path.join(directory, 'outside.txt')
    write(outside, 'outside')
    const receiptFile = path.join(root, pkg.receiptName(provider))
    const receipt = JSON.parse(fs.readFileSync(receiptFile))
    receipt.files['../../outside.txt'] = crypto.createHash('sha256').update('outside').digest('hex')
    receipt.payloadDigest = crypto.createHash('sha256').update(JSON.stringify(receipt.files)).digest('hex')
    receipt.payloadGeneration = `${provider}-v2.0.0-${receipt.payloadDigest.slice(0, 16)}`
    fs.writeFileSync(receiptFile, JSON.stringify(receipt))
    const before = snapshot(root)
    assert.throws(() => pkg.uninstall(provider, root), /Invalid receipt file/)
    assert.deepEqual(snapshot(root), before)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
  })
  test(`${provider}: WAITING_USER and corrupt activation history block uninstall without mutation`, t => {
    const { root } = context(t)
    pkg.install(provider, root)
    const record = path.join(root, '.autoprompt-private/activations/one/activation.json')
    for (const state of [JSON.stringify({ providerId: provider, status: 'revoked', outcome: 'WAITING_USER' }), '{broken']) {
      write(record, state)
      const before = snapshot(root)
      assert.throws(() => pkg.uninstall(provider, root))
      assert.deepEqual(snapshot(root), before)
    }
  })
}
module.exports = { context, write, original, snapshot, publicationFault, registerProviderLifecycle, pkg, ROOT }
