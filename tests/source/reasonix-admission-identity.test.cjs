'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { runtimeIdentityBody, runtimeIdentity } = require('../../agents/reasonix/workflow/admission.js')
const hash = 'a'.repeat(64)
function fixture() {
  return { installed: { provider: 'reasonix', files: {
    'agents/contracts/reasonix-live-conformance-evidence.json': hash,
    'agents/contracts/reasonix-trusted-public-keys.json': hash,
    'other/reasonix-live-conformance-evidence.json': hash,
    'agents/reasonix/workflow/native.js': hash,
  } }, executable: { provider: 'reasonix', path: path.resolve('fixture-reasonix'), sha256: hash,
    version: '1.30.0', runtimeIdentity: { sha256: hash, fileCount: 2, packageCount: 0 } } }
}
test('Reasonix identity excludes only the two exact trust documents', () => {
  const { installed, executable } = fixture()
  assert.deepEqual(Object.keys(runtimeIdentityBody(installed, executable).files), [
    'agents/reasonix/workflow/native.js', 'other/reasonix-live-conformance-evidence.json',
  ])
  const before = runtimeIdentity(installed, executable)
  installed.files['other/reasonix-live-conformance-evidence.json'] = 'b'.repeat(64)
  assert.notEqual(runtimeIdentity(installed, executable), before)
})
test('Reasonix identity binds local path and complete native dependency summary', () => {
  const { installed, executable } = fixture()
  const before = runtimeIdentity(installed, executable)
  for (const changed of [
    { ...executable, path: path.resolve('relocated-reasonix') },
    { ...executable, runtimeIdentity: { ...executable.runtimeIdentity, sha256: 'b'.repeat(64) } },
    { ...executable, runtimeIdentity: { ...executable.runtimeIdentity, fileCount: 3 } },
  ]) assert.notEqual(runtimeIdentity(installed, changed), before)
  assert.throws(() => runtimeIdentity(installed, { ...executable, runtimeIdentity: undefined }), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})
test('Reasonix identity refuses malformed receipt paths and wrong provider bindings', () => {
  for (const file of ['../outside', 'sub/../outside', 'sub\\outside', '/absolute', 'C:outside']) {
    const { installed, executable } = fixture()
    installed.files[file] = hash
    assert.throws(() => runtimeIdentity(installed, executable), { code: 'PAYLOAD_INVALID' })
  }
  const { installed, executable } = fixture()
  assert.throws(() => runtimeIdentity({ ...installed, provider: 'grok' }, executable), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})
