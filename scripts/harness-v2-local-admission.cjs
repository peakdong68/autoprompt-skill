#!/usr/bin/env node
'use strict'

// Local evidence is never a signature authority. This tool makes the handoff
// auditable: an actual native diagnostic and a separately reviewed live report
// become one runtime-bound request; a distinct authority must sign that digest.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const packaging = require('./harness-v2-package.cjs')
const native = require('./harness-v2-native.cjs')
const admission = require('./harness-v2-admission.cjs')
const { acquire, release, RootGuard } = require('./install/operation-lock.cjs')

const HASH = /^[a-f0-9]{64}$/
const fail = (message, code = 'LOCAL_ADMISSION_INVALID') => {
  const error = new Error(message); error.code = code; throw error
}
const canonical = value => JSON.stringify(value)
const readJson = file => JSON.parse(native.readBound(file).toString('utf8'))
const same = (left, right) => canonical(left) === canonical(right)

function requiredLiveReport(report, provider, runtimeIdentityHash, nativeDiagnosticSha256) {
  if (report?.schemaVersion !== 'harness-v2-reviewed-live-conformance.v1' || report.provider !== provider ||
      report.runtimeIdentityHash !== runtimeIdentityHash || report.nativeDiagnosticSha256 !== nativeDiagnosticSha256 ||
      report.status !== 'passed' || typeof report.reviewedAt !== 'string' || !Number.isFinite(Date.parse(report.reviewedAt)) ||
      !report.reviewer || typeof report.reviewer.issuer !== 'string' || report.reviewer.issuer.length < 3 ||
      typeof report.reviewer.reviewId !== 'string' || report.reviewer.reviewId.length < 8 ||
      !Array.isArray(report.verifiedCapabilities) || !same([...report.verifiedCapabilities].sort(), [...admission.REQUIRED].sort()) ||
      !Array.isArray(report.evidence) || report.evidence.length < 1 || report.evidence.some(item =>
        !item || typeof item.id !== 'string' || !HASH.test(item.sha256 || '') || typeof item.kind !== 'string')) {
    fail('Reviewed live-conformance report is incomplete, not passed, or not bound to this exact native diagnostic/runtime')
  }
  return report
}

function nativeDiagnostic(report, reportPath, provider, executable, runtimeIdentity) {
  const item = report?.providers?.filter(value => value?.provider === provider)
  if (report?.schemaVersion !== 'harness-v2-local-diagnostic.v1' || report.evidenceKind !== 'local-executable-diagnostic' ||
      !Array.isArray(item) || item.length !== 1 || path.resolve(report.evidenceDirectory || '') !== path.dirname(reportPath) ||
      path.resolve(path.join(report.evidenceDirectory, 'report.json')) !== reportPath) {
    fail('Native diagnostic must be a durable, non-injected report in its declared evidence directory')
  }
  const providerReport = item[0], tests = providerReport.nativeTests
  if (providerReport.executable?.status !== 'supported' || providerReport.executable.path !== executable.path ||
      providerReport.executable.sha256 !== executable.sha256 || tests?.status !== 'supported' ||
      tests.scope !== 'native-binary-local-model-service' || !Array.isArray(tests.cases) || !tests.cases.length ||
      tests.cases.some(value => value?.status !== 'passed') ||
      (provider !== 'reasonix' && (providerReport.adapterProbe?.nativeRuntimeIdentity === undefined ||
        !same(providerReport.adapterProbe.nativeRuntimeIdentity, runtimeIdentity)))) {
    fail('Native diagnostic lacks complete actual-binary passes bound to this executable and runtime')
  }
  return providerReport
}

function createRequest(options = {}) {
  const provider = options.provider
  const reasonix = provider === 'reasonix'
  const packageApi = reasonix ? require('./reasonix-package.cjs') : packaging
  const nativeApi = reasonix ? require('../agents/reasonix/workflow/native.js') : native
  const admissionApi = reasonix ? require('../agents/reasonix/workflow/admission.js') : admission
  const root = reasonix ? packageApi.resolveRoot({ ...(options.env || process.env), AUTOPROMPT_INSTALL_ROOT: options.root }) :
    packageApi.resolveRoot(provider, { ...(options.env || process.env), AUTOPROMPT_INSTALL_ROOT: options.root })
  const installed = reasonix ? packageApi.verify(root) : packageApi.verify(provider, root)
  const executable = reasonix ? nativeApi.probeExecutable({ executable: options.executable, env: options.env || process.env }) :
    nativeApi.probeExecutable({ provider, executable: options.executable, env: options.env || process.env })
  const identityBody = reasonix ? admissionApi.runtimeIdentityBody(installed, executable) : admissionApi.runtimeIdentityBody(provider, installed, executable)
  const runtimeIdentityHash = reasonix ? admissionApi.runtimeIdentity(installed, executable) : admissionApi.runtimeIdentity(provider, installed, executable)
  const reportPath = path.resolve(options.report || '')
  const liveReportPath = path.resolve(options.liveReport || '')
  if (!path.isAbsolute(options.report || '') || !path.isAbsolute(options.liveReport || '')) fail('Report paths must be absolute')
  const reportBytes = nativeApi.readBound(reportPath), report = JSON.parse(reportBytes)
  const providerReport = nativeDiagnostic(report, reportPath, provider, executable, executable.runtimeIdentity)
  const nativeDiagnosticSha256 = nativeApi.sha256(reportBytes)
  const liveBytes = nativeApi.readBound(liveReportPath), live = requiredLiveReport(JSON.parse(liveBytes), provider, runtimeIdentityHash, nativeDiagnosticSha256)
  const createdAt = options.createdAt || new Date().toISOString()
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) fail('Request creation time is invalid')
  const request = { schemaVersion: 'harness-v2-admission-request.v1', provider, createdAt,
    runtimeIdentityHash, runtimeIdentityBody: identityBody,
    installation: { payloadDigest: installed.payloadDigest, payloadGeneration: installed.payloadGeneration },
    nativeDiagnostic: { path: reportPath, sha256: nativeDiagnosticSha256, suite: providerReport.nativeTests.suite,
      cases: providerReport.nativeTests.cases.map(value => value.name), scope: providerReport.nativeTests.scope },
    reviewedLiveConformance: { path: liveReportPath, sha256: nativeApi.sha256(liveBytes), reviewer: live.reviewer,
      evidence: live.evidence.map(value => ({ id: value.id, kind: value.kind, sha256: value.sha256 })) } }
  return { request, requestSha256: nativeApi.sha256(canonical(request)), root, installed, executable, reasonix, admissionApi, packageApi, nativeApi }
}

function writeNew(file, value) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('Output path must be absolute')
  const parent = path.dirname(file)
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail('Output parent must already exist')
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function importAdmission(options = {}) {
  if (!path.isAbsolute(options.request || '') || !path.isAbsolute(options.evidence || '') ||
      !path.isAbsolute(options.keys || '')) fail('Request and certificate paths must be absolute')
  const requestBytes = native.readBound(options.request)
  const savedRequest = JSON.parse(requestBytes)
  if (!savedRequest.createdAt) fail('Admission request has no creation time')
  const prepared = createRequest({ ...options, createdAt: savedRequest.createdAt })
  if (!same(savedRequest, prepared.request)) fail('Admission request differs from the current exact diagnostic/live/runtime bindings')
  const evidenceBytes = prepared.nativeApi.readBound(path.resolve(options.evidence || ''))
  const keyBytes = prepared.nativeApi.readBound(path.resolve(options.keys || ''))
  const target = prepared.reasonix ? prepared.admissionApi.importedTrustDirectory(prepared.root) : admission.importedTrustDirectory(prepared.root, options.provider)
  const parent = path.dirname(target)
  const lease = acquire(prepared.root, `import-conformance-${options.provider}-v2`)
  let stage
  try {
    if (!prepared.reasonix) packaging.assertNoResumableActivation(options.provider, prepared.root)
    if (fs.existsSync(target)) fail('Imported conformance trust already exists; remove it only through a reviewed replacement workflow')
    const guard = new RootGuard(prepared.root)
    let ancestor = prepared.root
    for (const component of path.relative(prepared.root, parent).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, component)
      guard.assertParent(ancestor)
      if (!fs.existsSync(ancestor)) fs.mkdirSync(ancestor, { mode: 0o700 })
      guard.assertExisting(ancestor, 'directory')
    }
    guard.assertParent(target)
    stage = path.join(parent, `.stage-${crypto.randomUUID()}`); fs.mkdirSync(stage, { mode: 0o700 })
    fs.writeFileSync(path.join(stage, 'evidence.json'), evidenceBytes, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(stage, 'trusted-public-keys.json'), keyBytes, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(stage, 'request.json'), requestBytes, { flag: 'wx', mode: 0o600 })
    const manifest = { schemaVersion: 'harness-v2-imported-admission.v1', provider: options.provider, trustDirectory: target,
      conformanceRequestSha256: prepared.requestSha256, requestSha256: prepared.nativeApi.sha256(requestBytes), importedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(stage, 'admission.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    if (prepared.reasonix) prepared.admissionApi.verifyAdmission(prepared.installed, prepared.executable,
      { trustDirectory: stage, conformanceRequestSha256: prepared.requestSha256 })
    else admission.verifyAdmission(options.provider, prepared.installed, prepared.executable,
      { trustDirectory: stage, conformanceRequestSha256: prepared.requestSha256 })
    guard.assertExisting(stage, 'directory'); guard.assertParent(target)
    fs.renameSync(stage, target); stage = null
    return { status: 'imported', provider: options.provider, trustDirectory: target, conformanceRequestSha256: prepared.requestSha256 }
  } finally {
    if (stage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true })
    release(lease)
  }
}

function parse(argv) {
  const [action, ...rest] = argv
  if (!['request', 'import'].includes(action)) fail('Usage: harness-v2-local-admission.cjs <request|import> --provider NAME --root ABSOLUTE --executable ABSOLUTE --report ABSOLUTE --live-report ABSOLUTE [--output ABSOLUTE | --request ABSOLUTE --evidence ABSOLUTE --keys ABSOLUTE]', 'USAGE')
  const result = { action }
  const names = new Set(['--provider', '--root', '--executable', '--report', '--live-report', '--output', '--request', '--evidence', '--keys'])
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1]
    const key = flag?.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (!names.has(flag) || !value || value.startsWith('--') || Object.hasOwn(result, key)) fail('Invalid local admission arguments', 'USAGE')
    result[key] = value
  }
  for (const name of ['provider', 'root', 'executable', 'report', 'liveReport']) if (!result[name]) fail(`Missing --${name.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`, 'USAGE')
  if (action === 'request' && !result.output) fail('Missing --output', 'USAGE')
  if (action === 'import') for (const name of ['request', 'evidence', 'keys']) if (!result[name]) fail(`Missing --${name}`, 'USAGE')
  return result
}

if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2))
    const result = options.action === 'request' ? createRequest(options) : importAdmission(options)
    if (options.action === 'request') { writeNew(options.output, result.request); process.stdout.write(`${JSON.stringify({ status: 'requested', request: options.output, requestSha256: result.requestSha256 })}\n`) }
    else process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) { process.stderr.write(`${error.code || 'LOCAL_ADMISSION_FAILED'}: ${error.message}\n`); process.exitCode = 1 }
}

module.exports = { requiredLiveReport, nativeDiagnostic, createRequest, importAdmission, parse }
