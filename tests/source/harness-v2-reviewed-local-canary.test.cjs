'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const crypto = require('node:crypto')
const canary = require('../../scripts/harness-v2-canary.cjs')
const h = value => crypto.createHash('sha256').update(value).digest('hex')
function fixture() {
  const files = { 'node_modules/@iarna/toml/package.json': h('scoped-package'), 'scripts/harness-v2-transport.cjs': 'd'.repeat(64), 'scripts/harness-v2-canary.cjs': 'e'.repeat(64),
    'tests/closed/isolation.cjs': h('case:0'), 'tests/closed/topologyEnforcement.cjs': h('case:1'), 'tests/closed/privateSkillRoot.cjs': h('case:2'), 'tests/closed/eventStreaming.cjs': h('case:3'), 'tests/closed/toolOutputCapture.cjs': h('case:4'), 'tests/closed/stableChildIdentity.cjs': h('case:5'), 'tests/closed/sameContextContinuation.cjs': h('case:6'), 'tests/closed/cancellation.cjs': h('case:7'), 'tests/closed/isolatedChecking.cjs': h('case:8'), 'tests/closed/processOwnership.cjs': h('case:9'), 'tests/closed/modelRouting.cjs': h('case:10'), 'scripts/harness-v2-trust/evidence.json': 'a'.repeat(64), 'scripts/harness-v2-trust/trusted-public-keys.json': 'b'.repeat(64) }
  const installed = { payloadDigest: 'a'.repeat(64), files }
  const portableBody = { schemaVersion: 1, provider: 'claude', platform: process.platform, architecture: process.arch, files: [['entrypoint/native','c'.repeat(64)],['interpreter/node','d'.repeat(64)],['npm/fixture/package.json','e'.repeat(64)]] }
  const executable = { sha256: 'b'.repeat(64), version: '1.2.3', portableRuntimeIdentity: { ...portableBody, sha256: h(JSON.stringify(portableBody)), fileCount: 3, packageCount: 1 } }
  const releaseScope = canary.portableIdentity('claude', installed, executable)
  const body = { schemaVersion: 'harness-v2-reviewed-local-canary.v1', policy: 'reviewed-local-release-v1', provider: 'claude', status: 'reviewed',
    releaseScope, releaseIdentityHash: canary.releaseIdentity('claude', installed, executable), protocol: { source: 'scripts/harness-v2-transport.cjs', sha256: 'd'.repeat(64) }, canaryImplementation: { source: 'scripts/harness-v2-canary.cjs', sha256: 'e'.repeat(64) },
    capabilityCases: Object.fromEntries(canary.REQUIRED.map((name, index) => [name, { source: `tests/closed/${name}.cjs`, sha256: h(`case:${index}`), testName: `closed native ${name} verification` }])), liveEvidence: [{ id: 'astra-reviewed-live-source', sha256: 'f'.repeat(64) }],
    reviewer: { issuer: 'maintainer-reviewed-local-authority', reviewId: 'review-12345678' }, issuedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' }
  body.reviewDigest = h(canary.canonical(body)); return { installed, executable, body }
}
test('reviewed-local release verifier binds portable native identity and every declared capability case', () => {
  const f = fixture(), result = canary.verifyReview(f.body, 'claude', f.installed, f.executable, Date.parse('2026-09-08T00:00:00.000Z'))
  assert.equal(result.mode, 'reviewed-local-pending')
  const observations = canary.REQUIRED.map(capability => ({ capability, status: 'passed', caseSha256: f.body.capabilityCases[capability].sha256, observationSha256: h(capability) }))
  assert.equal(canary.verifyObservations(result, observations).length, canary.REQUIRED.length)
})
test('reviewed-local verifier fails closed on expiry, portable dependency drift, missing case, and incomplete observations', () => {
  const f = fixture(), now = Date.parse('2026-09-08T00:00:00.000Z')
  for (const mutate of [
    value => { value.expiresAt = '2026-09-02T00:00:00.000Z' },
    value => { delete value.capabilityCases.isolation },
    value => { value.reviewDigest = '0'.repeat(64) },
  ]) { const copy = structuredClone(f.body); mutate(copy); assert.throws(() => canary.verifyReview(copy, 'claude', f.installed, f.executable, now), { code: 'REVIEWED_LOCAL_REJECTED' }) }
  const changed = { ...f.executable, portableRuntimeIdentity: { ...f.executable.portableRuntimeIdentity, sha256: '9'.repeat(64) } }
  assert.throws(() => canary.verifyReview(f.body, 'claude', f.installed, changed, now), { code: 'REVIEWED_LOCAL_REJECTED' })
  const pending = canary.verifyReview(f.body, 'claude', f.installed, f.executable, now)
  assert.throws(() => canary.verifyObservations(pending, []), { code: 'REVIEWED_LOCAL_REJECTED' })
})

test('release selection permits other platform and native version reviews but rejects ambiguous or missing current scope', () => {
  const f = fixture()
  const others = ['platform', 'architecture', 'executableVersion'].map(field => {
    const record = structuredClone(f.body)
    record.releaseScope[field] = `other-${record.releaseScope[field]}`
    record.releaseIdentityHash = h(canary.canonical(record.releaseScope))
    delete record.reviewDigest
    record.reviewDigest = h(canary.canonical(record))
    return record
  })
  const selected = canary.selectReview([...others, f.body], 'claude', f.installed, f.executable)
  assert.equal(selected, f.body)
  assert.equal(canary.verifyReview(selected, 'claude', f.installed, f.executable, Date.parse('2026-09-08')).mode, 'reviewed-local-pending')
  for (const records of [others, [f.body, ...others, structuredClone(f.body)], {}]) {
    assert.throws(() => canary.selectReview(records, 'claude', f.installed, f.executable), { code: 'REVIEWED_LOCAL_REJECTED' })
  }
  assert.equal(canary.selectReview([], 'claude', f.installed, f.executable), null)
  const forged = { ...f.body, releaseScope: others[0].releaseScope }
  assert.throws(() => canary.verifyReview(canary.selectReview([forged], 'claude', f.installed, f.executable), 'claude', f.installed, f.executable), { code: 'REVIEWED_LOCAL_REJECTED' })
})

function activationFixture() {
  const f = fixture(), proofSha256 = h('proof')
  const executable = { ...f.executable, path: '/private/native', runtimeIdentity: { sha256: h('local dependencies'), fileCount: 3, packageCount: 1 } }
  const record = { schemaVersion: 2, providerId: 'claude', activationId: 'activation-123',
    payloadDigest: f.installed.payloadDigest, createdAt: '2026-09-08T00:00:00.000Z',
    capability: { generation: 1, expiresAt: '2026-09-09T00:00:00.000Z' },
    request: { sha256: h('request') }, connectionSha256: h('model configuration'), target: { realpath: '/private/target' },
    executable, activationBoundary: { enforcementProof: { sha256: proofSha256 } } }
  const proof = { nativeExecutable: executable.path, admissionTrust: { kind: 'reviewed-local-pending', reviewDigest: f.body.reviewDigest } }
  const challenge = Buffer.alloc(32, 1).toString('base64url')
  const artifacts = canary.REQUIRED.map(capability => {
    const item = f.body.capabilityCases[capability]
    const value = { schemaVersion:'harness-v2-closed-canary-observation.v1', capability,
      caseSha256:item.sha256, testName:item.testName, activationId:record.activationId,
      generation:1, challenge, requestSha256:record.request.sha256, target:record.target.realpath,
      executableSha256:executable.sha256, executableRuntimeIdentity:executable.runtimeIdentity,
      connectionSha256:record.connectionSha256, payloadDigest:record.payloadDigest,
      enforcementProofSha256:proofSha256, reviewDigest:f.body.reviewDigest, outputSha256:h(`output:${capability}`) }
    const bytes = JSON.stringify(value)
    return { capability, bytes, sha256:h(bytes) }
  })
  record.reviewedLocalCanary = { reviewDigest:f.body.reviewDigest, releaseIdentityHash:f.body.releaseIdentityHash,
    executableSha256:executable.sha256, nativeRuntimeIdentity:executable.portableRuntimeIdentity,
    observedAt:'2026-09-08T00:01:00.000Z', challenge,
    observations:artifacts.map(a => ({ capability:a.capability, status:'passed', caseSha256:f.body.capabilityCases[a.capability].sha256, observationSha256:a.sha256 })) }
  return { provider:'claude', installed:f.installed, record, proof, proofSha256, review:f.body, artifacts, now:Date.parse('2026-09-08T00:02:00.000Z') }
}

test('persisted local canary rejects replay across every activation context binding', () => {
  const original = activationFixture()
  assert.equal(canary.verifyActivationProof(original).mode, 'reviewed-local-pending')
  for (const mutate of [
    x => { x.record.activationId = 'different' },
    x => { x.record.capability.generation++ },
    x => { x.record.target.realpath = '/other/target' },
    x => { x.record.request.sha256 = h('other request') },
    x => { x.record.connectionSha256 = h('other model configuration') },
    x => { x.record.executable.runtimeIdentity.sha256 = h('changed dependencies') },
    x => { x.record.reviewedLocalCanary.challenge = Buffer.alloc(32, 2).toString('base64url') },
    x => { x.proofSha256 = h('other proof') },
    x => { x.record.payloadDigest = h('other package') },
    x => { x.record.capability.expiresAt = '2026-09-07T00:00:00.000Z' },
    x => { x.artifacts[0].bytes += ' ' },
    x => { x.artifacts[0] = x.artifacts[1] },
    x => { x.record.reviewedLocalCanary.observations.pop() },
  ]) {
    const changed = structuredClone(original); mutate(changed)
    assert.throws(() => canary.verifyActivationProof(changed), { code:'REVIEWED_LOCAL_REJECTED' })
  }
})

test('Hermes release scope uses the validated portable launcher while raw activation identity remains separate', () => {
  const f = fixture()
  const body = { schemaVersion: 1, provider: 'hermes', platform: process.platform, architecture: process.arch,
    files: [['hermes/launcher/hermes', h('normalized launcher')], ['interpreter/python', h('python')]] }
  const executable = { ...f.executable, portableRuntimeIdentity: { ...body, sha256: h(JSON.stringify(body)), fileCount: 2, packageCount: 0 } }
  const moved = { ...executable, sha256: h('different absolute shebang') }
  assert.deepEqual(canary.portableIdentity('hermes', f.installed, executable), canary.portableIdentity('hermes', f.installed, moved))
  assert.equal(canary.portableIdentity('hermes', f.installed, moved).executableReviewSha256, h('normalized launcher'))
  const noLauncherBody = { ...body, files: [['interpreter/python', h('python')]] }
  assert.throws(() => canary.portableIdentity('hermes', f.installed, { ...executable, portableRuntimeIdentity: { ...noLauncherBody, sha256: h(JSON.stringify(noLauncherBody)), fileCount: 1, packageCount: 0 } }), { code: 'REVIEWED_LOCAL_REJECTED' })
})

test('portable native identity accepts ordinary relative labels and rejects unsafe paths', () => {
  const f = fixture()
  const body = { schemaVersion: 1, provider: 'hermes', platform: process.platform, architecture: process.arch,
    files: [['hermes/launcher/hermes', h('launcher')], ['python/plat-site-packages/pytz/zoneinfo/Etc/GMT+0', h('zone')], ['python/plat-site-packages/wcwidth/textwrap.py,cover', h('cover')]] }
  const executable = { ...f.executable, portableRuntimeIdentity: { ...body, sha256: h(JSON.stringify(body)), fileCount: 3, packageCount: 1 } }
  assert.equal(canary.portableIdentity('hermes', f.installed, executable).executableReviewSha256, h('launcher'))
  for (const label of ['python/../outside', '/python/absolute', 'python\\windows', 'python/control\u0000name']) {
    const unsafe = { ...body, files: [['hermes/launcher/hermes', h('launcher')], [label, h('zone')], ['python/plat-site-packages/wcwidth/textwrap.py,cover', h('cover')]] }
    const changed = { ...executable, portableRuntimeIdentity: { ...unsafe, sha256: h(JSON.stringify(unsafe)), fileCount: 3, packageCount: 1 } }
    assert.throws(() => canary.portableIdentity('hermes', f.installed, changed), { code: 'REVIEWED_LOCAL_REJECTED' })
  }
})
