'use strict'

const path = require('node:path')
const { readBound, sha256, ReasonixError } = require('./native.js')
const { verifyCapabilityAttestation } = require('../../codex/workflow/router.js')

const REQUIRED = Object.freeze(['isolation', 'topologyEnforcement', 'privateSkillRoot', 'eventStreaming', 'toolOutputCapture', 'stableChildIdentity', 'sameContextContinuation', 'cancellation', 'isolatedChecking', 'processOwnership', 'modelRouting'])
const HASH = /^[a-f0-9]{64}$/
function importedTrustDirectory(root) { return path.join(path.resolve(root), '.autoprompt-private', 'conformance', 'v2', 'reasonix') }

// Release conformance is independent of this activation. A local hash is an
// integrity binding, never evidence that a provider capability was verified.
function runtimeIdentityBody(installed, executable) {
  const files = Object.fromEntries(Object.entries(installed.files).filter(([file]) =>
    !/reasonix-(live-conformance-evidence|trusted-public-keys)\.json$/.test(file)))
  return { provider: 'reasonix', executableSha256: executable.sha256,
    version: executable.version, platform: process.platform, architecture: process.arch, files }
}

function runtimeIdentity(installed, executable) { return sha256(JSON.stringify(runtimeIdentityBody(installed, executable))) }

function verifyAdmission(installed, executable, options = {}) {
  const imported = options.trustDirectory
  if (imported !== undefined && (!path.isAbsolute(imported) || !HASH.test(options.conformanceRequestSha256 || '') ||
      path.resolve(imported) === path.resolve(installed.bundle) || path.resolve(imported).startsWith(`${path.resolve(installed.bundle)}${path.sep}`))) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported conformance trust must be external and bound to an exact reviewed request')
  }
  const evidencePath = imported ? path.join(imported, 'evidence.json') : path.join(installed.bundle, 'agents/contracts/reasonix-live-conformance-evidence.json')
  const keyPath = imported ? path.join(imported, 'trusted-public-keys.json') : path.join(installed.bundle, 'agents/contracts/reasonix-trusted-public-keys.json')
  const evidenceBytes = readBound(evidencePath), keyBytes = readBound(keyPath)
  const evidence = JSON.parse(evidenceBytes)
  const ring = JSON.parse(keyBytes)
  const attestation = evidence.attestation
  const trustedPublicKeys = Object.fromEntries((ring.keys || []).map(key => [key.keyId, key.publicKeyPem]))
  const key = (ring.keys || []).filter(item => item?.keyId === attestation?.signature?.keyId)
  if (evidence.status !== 'passed' || key.length !== 1 || key[0].independent !== true || key[0].issuer !== attestation?.issuer ||
      !Array.isArray(key[0].providers) || !key[0].providers.includes('reasonix') || attestation?.verificationMethod !== 'live-conformance-suite' ||
      /autoprompt.*activation/i.test(attestation?.issuer || '') || attestation?.signature?.algorithm !== 'ed25519') {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix v2 requires an independent signed live-conformance record for this runtime before activation')
  }
  const identity = runtimeIdentity(installed, executable)
  if (imported && attestation?.providerAdmissionSha256 !== options.conformanceRequestSha256) {
    throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix imported certificate is not bound to the reviewed local admission request')
  }
  const verification = verifyCapabilityAttestation(attestation, {
    providerId: 'reasonix', runtimeIdentityHash: identity, activationNonce: evidence.activationNonce,
    requiredCapabilities: REQUIRED, trustedPublicKeys,
  })
  if (!verification.valid) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix live-conformance admission failed', { errors: verification.errors })
  return { ...verification, runtimeIdentityBody: runtimeIdentityBody(installed, executable), runtimeIdentityHash: identity, evidenceSha256: sha256(JSON.stringify(evidence)),
    trustSource: { kind: imported ? 'explicit-private-import' : 'shipped-release', directory: imported || installed.bundle,
      evidenceSha256: sha256(evidenceBytes), keyRingSha256: sha256(keyBytes), ...(imported ? { conformanceRequestSha256: options.conformanceRequestSha256 } : {}) } }
}

module.exports = { REQUIRED, runtimeIdentityBody, runtimeIdentity, importedTrustDirectory, verifyAdmission }
