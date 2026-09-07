'use strict'

const path = require('node:path')
const { readBound, sha256, ReasonixError } = require('./native.js')
const { verifyCapabilityAttestation } = require('../../codex/workflow/router.js')

const REQUIRED = Object.freeze(['isolation', 'topologyEnforcement', 'privateSkillRoot', 'eventStreaming', 'toolOutputCapture', 'stableChildIdentity', 'sameContextContinuation', 'cancellation', 'isolatedChecking', 'processOwnership', 'modelRouting'])

// Release conformance is independent of this activation. A local hash is an
// integrity binding, never evidence that a provider capability was verified.
function runtimeIdentityBody(installed, executable) {
  const files = Object.fromEntries(Object.entries(installed.files).filter(([file]) =>
    !/reasonix-(live-conformance-evidence|trusted-public-keys)\.json$/.test(file)))
  return { provider: 'reasonix', executableSha256: executable.sha256,
    version: executable.version, platform: process.platform, architecture: process.arch, files }
}

function runtimeIdentity(installed, executable) { return sha256(JSON.stringify(runtimeIdentityBody(installed, executable))) }

function verifyAdmission(installed, executable) {
  const evidence = JSON.parse(readBound(path.join(installed.bundle, 'agents/contracts/reasonix-live-conformance-evidence.json')))
  const ring = JSON.parse(readBound(path.join(installed.bundle, 'agents/contracts/reasonix-trusted-public-keys.json')))
  const attestation = evidence.attestation
  const trustedPublicKeys = Object.fromEntries((ring.keys || []).map(key => [key.keyId, key.publicKeyPem]))
  if (evidence.status !== 'passed' || attestation?.verificationMethod !== 'live-conformance-suite' ||
      attestation.issuer === 'autoprompt-reasonix-activation-v2' || attestation?.signature?.algorithm !== 'ed25519') {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix v2 requires an independent signed live-conformance record for this runtime before activation')
  }
  const identity = runtimeIdentity(installed, executable)
  const verification = verifyCapabilityAttestation(attestation, {
    providerId: 'reasonix', runtimeIdentityHash: identity, activationNonce: evidence.activationNonce,
    requiredCapabilities: REQUIRED, trustedPublicKeys,
  })
  if (!verification.valid) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix live-conformance admission failed', { errors: verification.errors })
  return { ...verification, runtimeIdentityBody: runtimeIdentityBody(installed, executable), runtimeIdentityHash: identity, evidenceSha256: sha256(JSON.stringify(evidence)) }
}

module.exports = { REQUIRED, runtimeIdentity, verifyAdmission }
