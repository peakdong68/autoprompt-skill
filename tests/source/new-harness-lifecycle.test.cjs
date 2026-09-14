'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { registerProviderLifecycle, context, write, snapshot, pkg } = require('../helpers/provider-lifecycle-contract.cjs')

registerProviderLifecycle('omp', { 'config.yml': 'theme: dark\ntask:\n  maxRecursionDepth: 1\n', 'custom.yml': 'broken: [yaml preserved\n' })
registerProviderLifecycle('deepseek', { 'settings.json': '{"custom":true}\n', '.agent-presets/custom/preset.yml': 'name: custom\n' })

test('OMP v2 profile and agent-dir overrides never create a detached discovery tree', t => {
  const { root, directory } = context(t)
  const home = path.join(directory, 'home')
  const env = { HOME: home, PI_CONFIG_DIR: '.omp-custom', PI_CODING_AGENT_DIR: root }
  assert.equal(pkg.resolveRoot('omp', env), root)
  assert.equal(pkg.resolveRoot('omp', { ...env, OMP_PROFILE: 'work', PI_PROFILE: 'other' }), path.join(home, '.omp-custom/profiles/work/agent'))
  assert.equal(pkg.resolveRoot('omp', { ...env, PI_PROFILE: 'legacy' }), path.join(home, '.omp-custom/profiles/legacy/agent'))
  pkg.install('omp', pkg.resolveRoot('omp', env))
  assert.equal(fs.existsSync(path.join(home, '.omp-custom')), false)
  assert.equal(fs.existsSync(path.join(root, 'agents')), false)
  assert.equal(pkg.launcherRelative('omp'), 'prompts/autoprompt.md')
  pkg.uninstall('omp', root)
  assert.equal(fs.existsSync(path.join(home, '.omp-custom')), false)
})

test('OMP v2 rejects traversal, invalid syntax and portable reserved profile names', t => {
  const { root } = context(t)
  for (const profile of ['..', '../escape', 'UPPER', 'con', 'name.', 'a/b', 'nul.txt', 'com1', 'x'.repeat(65)]) {
    assert.throws(() => pkg.resolveRoot('omp', { HOME: root, OMP_PROFILE: profile }), /Invalid OMP profile/, profile)
  }
  for (const profile of ['default', 'work', 'a-b_1.2']) assert.ok(path.isAbsolute(pkg.resolveRoot('omp', { HOME: root, OMP_PROFILE: profile })))
})

test('OMP v2 ignores forged detached legacy ownership when uninstalling its own receipt', t => {
  const { root, directory } = context(t)
  const outside = path.join(directory, 'detached/agents/ap-manager.md')
  write(outside, 'foreign role')
  write(path.join(root, '.autoprompt-install-receipt.json'), JSON.stringify({ files: [outside], detachedRoot: path.dirname(outside) }))
  const before = snapshot(root)
  pkg.install('omp', root)
  pkg.uninstall('omp', root)
  assert.deepEqual(snapshot(root), before)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'foreign role')
})

for (const order of [['omp', 'deepseek'], ['deepseek', 'omp']]) test(`providers sharing a root preserve distinct manual entries, bundles and history (${order.join(' then ')})`, t => {
  const { root } = context(t)
  const installed = Object.fromEntries(order.map(provider => [provider, pkg.install(provider, root)]))
  const { omp, deepseek } = installed
  assert.equal(pkg.install('omp', root).payloadDigest, omp.payloadDigest)
  assert.equal(pkg.verify('deepseek', root).payloadDigest, deepseek.payloadDigest)
  write(path.join(root, '.autoprompt-private/activations/foreign/activation.json'), JSON.stringify({ providerId: 'deepseek', status: 'active' }))
  pkg.uninstall('omp', root)
  assert.equal(fs.existsSync(omp.bundle), false)
  assert.equal(pkg.verify('deepseek', root).payloadDigest, deepseek.payloadDigest)
  assert.equal(fs.existsSync(pkg.launcherPath('deepseek', root)), true)
})

test('foreign manual entry exemptions require intact receipt, payload and exact launcher bytes', t => {
  const { root } = context(t)
  pkg.install('omp', root)
  const other = pkg.install('deepseek', root)
  const receipt = path.join(root, pkg.receiptName('deepseek'))
  const launcher = pkg.launcherPath('deepseek', root)
  const payload = path.join(other.bundle, 'agents/deepseek/VERSION')
  for (const [file, changed] of [[receipt, null], [receipt, '{}'], [launcher, 'custom launcher'], [payload, 'changed payload']]) {
    const original = fs.readFileSync(file)
    if (changed === null) fs.unlinkSync(file)
    else fs.writeFileSync(file, changed)
    const before = snapshot(root)
    for (const operation of [pkg.verify, pkg.install, pkg.uninstall]) {
      assert.throws(() => operation('omp', root), /Legacy managed discovery remains|receipt is invalid|Payload changed/)
      assert.deepEqual(snapshot(root), before)
    }
    fs.writeFileSync(file, original)
  }
  pkg.uninstall('omp', root)
  assert.equal(pkg.verify('deepseek', root).status, 'verified')
})

test('providers sharing the same discovery entry refuse collisions without corrupting the first installation', t => {
  const { root } = context(t)
  pkg.install('claude', root)
  const before = snapshot(root)
  assert.throws(() => pkg.install('deepseek', root), /Unowned launcher|Changed legacy/)
  assert.deepEqual(snapshot(root), before)
  assert.equal(pkg.verify('claude', root).status, 'verified')
})
