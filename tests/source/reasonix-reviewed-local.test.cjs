'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const admission = require('../../agents/reasonix/workflow/admission.js')
const canary = require('../../scripts/harness-v2-canary.cjs')
const configure = require('../../scripts/reasonix-configure.cjs')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function fixture() {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-reviewed-local-'))
  const cases = Object.fromEntries(admission.REQUIRED.map((capability, index) => [`tests/closed/${capability}.cjs`, hash(`case:${index}`)]))
  const files = { 'scripts/reasonix-configure.cjs': hash('configure'), 'scripts/harness-v2-canary.cjs': hash('canary'), ...cases }
  const installed = { provider: 'reasonix', bundle, payloadDigest: hash('payload'), files }
  const portableBase = { schemaVersion: 1, provider: 'reasonix', platform: process.platform, architecture: process.arch,
    files: [['entrypoint/reasonix', hash('reasonix')]] }
  const executable = { provider: 'reasonix', path: '/tmp/reasonix-fixture', sha256: hash('reasonix'), version: '1.30.0',
    portableRuntimeIdentity: { ...portableBase, sha256: hash(JSON.stringify(portableBase)), fileCount: 1, packageCount: 0 } }
  const releaseScope = canary.portableIdentity('reasonix', installed, executable)
  const body = { schemaVersion: 'harness-v2-reviewed-local-canary.v1', policy: 'reviewed-local-release-v1', provider: 'reasonix', status: 'reviewed',
    releaseScope, releaseIdentityHash: canary.releaseIdentity('reasonix', installed, executable),
    protocol: { source: 'scripts/reasonix-configure.cjs', sha256: files['scripts/reasonix-configure.cjs'] },
    canaryImplementation: { source: 'scripts/harness-v2-canary.cjs', sha256: files['scripts/harness-v2-canary.cjs'] },
    capabilityCases: Object.fromEntries(admission.REQUIRED.map(capability => [capability, { source: `tests/closed/${capability}.cjs`, sha256: files[`tests/closed/${capability}.cjs`], testName: `Reasonix closed ${capability} native case` }])),
    liveEvidence: [{ id: 'reviewer-native-proof', sha256: hash('native-proof') }], reviewer: { issuer: 'independent-reviewer', reviewId: 'review-12345678' },
    issuedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' }
  body.reviewDigest = hash(canary.canonical(body))
  const trust = path.join(bundle, 'scripts/harness-v2-trust')
  fs.mkdirSync(trust, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(trust, 'evidence.json'), JSON.stringify({ schemaVersion: 'harness-v2-live-conformance.v1', records: [], reviewedLocalRecords: [body] }))
  return { bundle, installed, executable, body }
}

test('Reasonix reviewed-local pending binds the common release record and rejects drift', () => {
  const f = fixture()
  try {
    const pending = admission.reviewedLocalPending(f.installed, f.executable, { now: Date.parse('2026-09-08T00:00:00.000Z') })
    assert.equal(pending.releaseIdentityHash, f.body.releaseIdentityHash)
    assert.equal(configure.reviewedLocalBindingMatches({ reviewedLocal: pending }, pending), true)
    assert.equal(configure.reviewedLocalBindingMatches({ reviewedLocal: { ...pending, reviewDigest: '0'.repeat(64) } }, pending), false)
    const foreign = structuredClone(f.body)
    foreign.releaseScope.platform = process.platform === 'win32' ? 'darwin' : 'win32'
    foreign.releaseIdentityHash = hash(canary.canonical(foreign.releaseScope))
    delete foreign.reviewDigest
    foreign.reviewDigest = hash(canary.canonical(foreign))
    const evidenceFile = path.join(f.bundle, 'scripts/harness-v2-trust/evidence.json')
    const writeReviews = records => fs.writeFileSync(evidenceFile, JSON.stringify({ reviewedLocalRecords: records }))
    const general = require('../../scripts/harness-v2-admission.cjs')
    const clock = { now: Date.parse('2026-09-08T00:00:00.000Z') }
    for (const read of [() => admission.reviewedLocalPending(f.installed, f.executable, clock),
      () => general.reviewedLocalPending('reasonix', f.installed, f.executable, clock)]) {
      writeReviews([foreign, f.body])
      assert.equal(read().releaseIdentityHash, pending.releaseIdentityHash)
      writeReviews([foreign, f.body, structuredClone(f.body)])
      assert.throws(read, { code: 'PROVIDER_UNSUPPORTED' })
      writeReviews([foreign])
      assert.throws(read, { code: 'PROVIDER_UNSUPPORTED' })
    }
    writeReviews([foreign, f.body])
    const changed = { ...f.executable, portableRuntimeIdentity: { ...f.executable.portableRuntimeIdentity, sha256: hash('changed') } }
    assert.throws(() => admission.reviewedLocalPending(f.installed, changed, { now: Date.parse('2026-09-08T00:00:00.000Z') }), { code: 'PROVIDER_UNSUPPORTED' })
  } finally { fs.rmSync(f.bundle, { recursive: true, force: true }) }
})

test('Reasonix fallback eligibility accepts only the exact shipped awaiting placeholder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-awaiting-'))
  try {
    const contracts = path.join(root, 'agents/contracts'); fs.mkdirSync(contracts, { recursive: true, mode: 0o700 })
    const file = path.join(contracts, 'reasonix-live-conformance-evidence.json')
    const placeholder = { schemaVersion: 'reasonix-live-conformance-evidence.v1', providerId: 'reasonix', status: 'awaiting-independent-conformance', attestation: null, activationNonce: null }
    const ringFile = path.join(contracts, 'reasonix-trusted-public-keys.json')
    fs.writeFileSync(ringFile, JSON.stringify({ schemaVersion: 1, providerId: 'reasonix', keys: [] }))
    fs.writeFileSync(file, JSON.stringify(placeholder))
    assert.equal(admission.awaitingIndependentConformance({ bundle: root }), true)
    for (const value of [
      { status: 'passed', attestation: null },
      { status: 'awaiting-independent-conformance', attestation: {} },
      { status: 'awaiting-independent-conformance' },
      { ...placeholder, schemaVersion: 'foreign' },
      { ...placeholder, providerId: 'foreign' },
      { ...placeholder, activationNonce: 'foreign' },
    ]) { fs.writeFileSync(file, JSON.stringify(value)); assert.equal(admission.awaitingIndependentConformance({ bundle: root }), false) }
    fs.writeFileSync(file, JSON.stringify(placeholder))
    for (const value of [{ schemaVersion: 1, providerId: 'reasonix', keys: [{}] }, { schemaVersion: 1, providerId: 'foreign', keys: [] }, {}]) {
      fs.writeFileSync(ringFile, JSON.stringify(value)); assert.equal(admission.awaitingIndependentConformance({ bundle: root }), false)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
