#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const packaging = require('./reasonix-package.cjs')
const { ReasonixError, connectionConfig, probeExecutable, readBound, privateDirectory, sha256, writePrivate } = require('../agents/reasonix/workflow/native.js')
const { acquire, release, RootGuard } = require('./install/operation-lock.cjs')
const core = require('../agents/codex/workflow/phase-budget.js')
const { processIdentityForPid } = require('../agents/codex/workflow/mission-lock.js')
const { createRunRecord } = require('../agents/codex/workflow/run-record.js')
const { ReasonixExecAdapter } = require('../agents/reasonix/workflow/transport.js')
const safety = require('./local-only-safety.cjs')
const { verifyAdmission } = require('../agents/reasonix/workflow/admission.js')
const { selectModelAssignment, validateReceiptBoundRegistry } = require('../agents/codex/workflow/effort-policy.js')

const PROFILE = Object.freeze({
  provider: 'reasonix', contractVersion: '2.0.0', commandSandbox: 'enforce', commandNetwork: false,
  configurationIsolation: 'private-home-and-empty-launch-directory', implicitSkills: false,
  externalTools: false, nestedDispatch: false,
})

function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function requestEnvelope(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new ReasonixError('INVALID_INPUT', 'Activation requires exact mission arguments after --')
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, argv }))
  return { argv, bytes: bytes.length, canonicalBase64: bytes.toString('base64'), canonicalJson: bytes.toString('utf8'), encoding: 'utf8-json', sha256: sha256(bytes) }
}

function credentialEnvironment(connection, root, environment) {
  let dotenv = ''
  const file = path.join(root, '.env')
  if (fs.existsSync(file)) dotenv = readBound(file).toString('utf8')
  const values = {}
  for (const provider of connection.providers) {
    const key = provider.api_key_env
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Provider credential environment name is invalid')
    if (typeof environment[key] === 'string' && environment[key]) { values[key] = environment[key]; continue }
    const match = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(dotenv)
    if (match) {
      let value = match[1].trim()
      if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { throw new ReasonixError('PROVIDER_UNSUPPORTED', `Invalid quoted credential: ${key}`) } }
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      values[key] = value
    }
  }
  return values
}

function prepareActivation(options = {}) {
  const environment = options.env || process.env
  const root = options.root || packaging.resolveRoot(environment)
  const installed = packaging.verify(root)
  const target = fs.realpathSync.native(options.target || process.cwd())
  if (!fs.statSync(target).isDirectory()) throw new ReasonixError('INVALID_INPUT', 'Mission target must be a directory')
  const request = requestEnvelope(options.missionArgs)
  const executable = probeExecutable({ env: environment, executable: options.executable })
  const admission = verifyAdmission(installed, executable)
  const connection = connectionConfig(path.join(root, 'config.toml'))
  const credentials = credentialEnvironment(connection, root, environment)
  const ttlSeconds = options.ttlSeconds === undefined ? 24 * 60 * 60 : Number(options.ttlSeconds)
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 24 * 60 * 60) {
    throw new ReasonixError('INVALID_INPUT', 'Activation lifetime must be 1 to 604800 seconds')
  }
  const lease = acquire(root, 'activate-reasonix-v2')
  try {
    const activationId = options.resume || options.activationId || `apv2-${crypto.randomBytes(16).toString('hex')}`
    if (!/^apv2-[a-f0-9]{32}$/.test(activationId)) throw new ReasonixError('INVALID_INPUT', 'Invalid activation id')
    const activationRoot = path.join(root, '.autoprompt-private', 'activations', activationId)
    const recordPath = path.join(activationRoot, 'activation.json')
    let record
    if (options.resume) {
      record = JSON.parse(readBound(recordPath))
      if (record.providerId !== 'reasonix' || record.activationId !== activationId || record.target.realpath !== target ||
          record.request.sha256 !== request.sha256 || record.payloadDigest !== installed.payloadDigest ||
          record.executable.sha256 !== executable.sha256 ||
          (record.status === 'active' && processIdentityForPid(record.ownerPid) !== null) ||
          record.connectionSha256 !== sha256(JSON.stringify(connection))) {
        throw new ReasonixError('RESUME_MISMATCH', 'Resume must bind the original request, target, payload, model configuration, and executable after the prior run stops')
      }
      if (Date.parse(record.capability.expiresAt) <= Date.now()) throw new ReasonixError('BUDGET_EXHAUSTED', 'The original run deadline has expired')
      record.capability.generation++
    } else {
      privateDirectory(activationRoot)
      const guard = new RootGuard(root)
      guard.assertExisting(activationRoot, 'directory')
      const profilePath = path.join(activationRoot, 'autoprompt.reasonix.profile.json')
      writePrivate(profilePath, `${JSON.stringify(PROFILE)}\n`)
      const profileSha256 = sha256(readBound(profilePath))
      const proof = { schemaVersion: 1, provider: 'reasonix', nativeExecutable: executable.path, runtimeIdentityBody: admission.runtimeIdentityBody, profilePath, profileSha256, checkerProfilePath: profilePath, checkerProfileSha256: profileSha256, selectedProfile: 'autoprompt', checkerSelectedProfile: 'autoprompt-checker', strictConfig: true }
      const proofPath = path.join(activationRoot, 'enforcement-proof.json')
      writePrivate(proofPath, `${JSON.stringify(proof)}\n`)
      const gitConfig = path.join(activationRoot, 'gitconfig')
      writePrivate(gitConfig, '')
      const ghConfigDir = path.join(activationRoot, 'gh')
      fs.mkdirSync(ghConfigDir, { mode: 0o700 })
      const nonce = crypto.randomBytes(24).toString('hex')
      const run = createRunRecord({
        targetPath: target, providerId: 'reasonix', runId: activationId, readOnly: true, exactTree: true,
        canonicalProviderPrivateRoot: path.join(activationRoot, 'r'), assertStartBoundary: false,
      })
      const metadataSha256 = sha256(readBound(path.join(run.runPath, 'metadata.json')))
      const modelFile = path.join(root, '.autoprompt-reasonix-models.json')
      const modelSelection = fs.existsSync(modelFile) ? validateSelection(JSON.parse(readBound(modelFile))) : { mode: 'provider-default', selector: 'off', models: [] }
      record = {
        schemaVersion: 2, providerId: 'reasonix', activationId, activationRoot,
        payloadDigest: installed.payloadDigest, payloadGeneration: installed.payloadGeneration,
        createdAt: new Date().toISOString(), request, target: { realpath: target }, executable,
        connectionSha256: sha256(JSON.stringify(connection)), modelSelection,
        contractVersions: { settings: '2.0.0', requestEnvelopeEntry: '2.0.0', outcome: '2.0.0', providerCapabilities: '2.0.0', activationRequest: '1.0.0' },
        capability: { generation: 1, parentSession: `${activationId}:owner`, parentRole: 'deterministic-control-plane', legalChildren: ['run-owner', 'route-analyst'], recordPath, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() },
        providerAttestation: { attestation: { activationNonce: nonce } },
        supervisorRuntime: { runPath: run.runPath, runId: activationId, metadataSha256, targetIdentity: run.targetIdentity, createdAt: new Date().toISOString() },
        supervisorEntry: { promptSha256: sha256(readBound(path.join(installed.bundle, 'agents/reasonix/SKILL.md'))) },
        activationBoundary: { gitConfig, ghConfigDir, payloadManifestSha256: installed.payloadDigest,
          supervisorAdapterSha256: sha256(readBound(path.join(installed.bundle, 'scripts/reasonix-configure.cjs'))),
          enforcementProof: { ...proof, path: proofPath, sha256: sha256(readBound(proofPath)) } },
      }
    }
    record.status = 'active'
    record.ownerPid = process.pid
    record.ownerIdentity = processIdentityForPid(process.pid)
    const attestationBody = { provider: 'reasonix', activationId, generation: record.capability.generation,
      admissionEvidenceSha256: admission.evidenceSha256, executableSha256: executable.sha256, payloadDigest: installed.payloadDigest, requestHash: request.sha256,
      targetIdentity: record.supervisorRuntime.targetIdentity, nonce: record.providerAttestation.attestation.activationNonce }
    record.activationAttestation = { hash: sha256(JSON.stringify(attestationBody)), ...attestationBody }
    atomicJson(recordPath, record)
    return {
      providerId: 'reasonix', verified: true, activationId, runId: activationId, activationRoot, recordPath, record,
      root, installed, connection, executable, requestArgv: request.argv,
      supervisorRuntime: record.supervisorRuntime, modelSelection: record.modelSelection,
      enforcementProof: record.activationBoundary.enforcementProof,
      profilePath: record.activationBoundary.enforcementProof.profilePath,
      checkerProfilePath: record.activationBoundary.enforcementProof.checkerProfilePath,
      activationAttestation: record.activationAttestation, entryPrompt: '$autoprompt',
      credentialEnvironment: credentials,
    }
  } finally { release(lease) }
}

async function supervise(options = {}) {
  const activation = prepareActivation(options)
  let runtime
  let outcome
  try {
    const target = activation.record.target.realpath
    const expectedBranch = childProcess.spawnSync('git', ['-C', target, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const safeOptions = { expectedBranch, configIsolationPath: activation.record.activationBoundary.gitConfig, ghConfigDir: activation.record.activationBoundary.ghConfigDir, enforcementProof: activation.enforcementProof }
    const environment = safety.createSafeChildGitEnvironment(target, options.env || process.env, safeOptions)
    const repair = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'local-only-safety.cjs'), '--repo', target, '--expected-branch', expectedBranch, '--repair', '--enforcement-proof', activation.enforcementProof.path, '--json'], { env: environment, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
    if (![0, 3].includes(repair.status)) throw new ReasonixError('LOCAL_BOUNDARY_UNAVAILABLE', 'Could not establish the v2 target boundary', { status: repair.status })
    const nativeRoot = path.join(activation.activationRoot, 'native')
    const context = {
      environment, expectedBranch, ExecutionAdapter: ReasonixExecAdapter,
      executionAdapterOptions: {
        nativeRoot, connection: activation.connection, executableBinding: activation.executable,
        credentialEnvironment: activation.credentialEnvironment,
        rolePrompt: role => {
          if (role === 'ap-run-owner') return readBound(path.join(activation.installed.bundle, 'agents/reasonix/SKILL.md')).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
          if (!/^ap-[a-z0-9-]+$/.test(role)) throw new ReasonixError('ROLE_POLICY_DENIED', 'Invalid Reasonix role')
          return readBound(path.join(activation.installed.bundle, 'agents/reasonix/skills', role, 'SKILL.md')).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
        },
      },
      assignmentResolver: input => resolveAssignment(activation.modelSelection, input),
    }
    const probe = { executable: activation.executable.path, cliVersion: activation.executable.version,
      evidenceHashes: activation.executable.evidenceHashes, eventStreaming: true, toolOutputCapture: true, sameContextContinuation: true }
    const runtimeOptions = core.createDefaultRuntimeOptions({ activation, probe, context })
    runtimeOptions.activationReceipt = activation
    runtime = new core.CodexSupervisorRuntime(runtimeOptions)
    const cancel = () => { runtime.cancel('operator signal').catch(error => { process.stderr.write(`Reasonix cancellation failed: ${error.code || 'FAILED'}\n`) }) }
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    try { outcome = await runtime.start() }
    finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
    return { ...outcome, activationId: activation.activationId, runPath: activation.supervisorRuntime.runPath }
  } finally {
    const latest = JSON.parse(readBound(activation.recordPath))
    latest.status = 'revoked'
    latest.revokedAt = new Date().toISOString()
    latest.outcome = outcome?.outcome || 'FAILED'
    atomicJson(activation.recordPath, latest)
  }
}

function launchActivation(options = {}) {
  const environment = options.env || process.env
  const root = packaging.resolveRoot(environment)
  const installed = packaging.verify(root)
  const activationId = options.resume || `apv2-${crypto.randomBytes(16).toString('hex')}`
  const requestPath = path.join(root, '.autoprompt-private', `launch-${crypto.randomUUID()}.json`)
  writePrivate(requestPath, JSON.stringify({ root, activationId, target: options.target, missionArgs: options.missionArgs, ttlSeconds: options.ttlSeconds, resume: options.resume }))
  try {
    const result = (options.spawnSync || childProcess.spawnSync)(process.execPath, [path.join(installed.bundle, 'scripts/reasonix-configure.cjs'), '--supervise', requestPath], {
      env: environment, stdio: options.stdio || 'inherit', shell: false,
    })
    if (result.error) throw result.error
    const recordPath = path.join(root, '.autoprompt-private', 'activations', activationId, 'activation.json')
    const record = fs.existsSync(recordPath) ? JSON.parse(readBound(recordPath)) : null
    return { status: result.status === null ? 1 : result.status, activationId, revoked: record ? record.status === 'revoked' : true }
  } finally { fs.unlinkSync(requestPath) }
}

function validateSelection(selection) {
  if (!selection || !['provider-default', 'explicit', 'automatic'].includes(selection.mode) ||
      !Array.isArray(selection.models) || selection.models.some(model => !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(model)) ||
      (selection.effort && !['low', 'medium', 'high', 'max'].includes(selection.effort))) throw new ReasonixError('INVALID_INPUT', 'Invalid Reasonix model selection')
  if (selection.mode === 'provider-default' && (selection.models.length || selection.effort)) throw new ReasonixError('INVALID_INPUT', 'Inherited model selection cannot override effort')
  if (selection.mode === 'automatic' || selection.models.length > 1) validateReceiptBoundRegistry(selection.registry)
  return selection
}

function resolveAssignment(selection, input) {
  validateSelection(selection)
  if (selection.mode === 'automatic' || selection.models.length > 1) {
    const entries = validateReceiptBoundRegistry(selection.registry).entries.filter(entry =>
      selection.mode === 'automatic' || selection.models.includes(entry.id || entry.model || entry.name))
    const result = selectModelAssignment({ role: input.logicalRole, difficulty: input.request?.difficulty,
      risk: input.request?.risk, registry: entries, explicitPin: { effort: selection.effort || null },
      requiredCapabilities: input.request?.requiredCapabilities || [], workload: input.request?.workload || {} })
    if (result.effort === 'xhigh') throw new ReasonixError('INVALID_EFFORT', 'Reasonix does not support xhigh; provide a supported explicit effort')
    return result
  }
  return { model: selection.models[0] || null, effort: selection.effort || null,
    source: selection.mode, registryMatched: false, routeIndependent: true }
}

function configure(options = {}) {
  const root = packaging.resolveRoot(options.env)
  packaging.verify(root)
  const selector = options.selector || 'off'
  const models = selector === 'off' || selector === 'auto' ? [] : selector.split(',').map(value => value.trim())
  const registry = options.modelMap ? JSON.parse(readBound(path.resolve(options.modelMap))) : undefined
  if (registry && registry.schemaVersion !== 'reasonix-model-registry.v1') throw new ReasonixError('INVALID_INPUT', 'Expected a Reasonix measured model registry')
  const record = validateSelection({ mode: selector === 'off' ? 'provider-default' : selector === 'auto' ? 'automatic' : 'explicit',
    selector, models, ...(options.effort ? { effort: options.effort } : {}), ...(registry ? { registry } : {}) })
  const lease = acquire(root, 'configure-reasonix-v2')
  try { atomicJson(path.join(root, '.autoprompt-reasonix-models.json'), record) }
  finally { release(lease) }
  return record
}

if (require.main === module) {
  if (process.argv[2] === '--supervise' && process.argv.length === 4) {
    let options
    try { options = JSON.parse(readBound(process.argv[3])) } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2 }
    if (options) supervise({ ...options, env: process.env }).then(result => {
      process.stdout.write(`${JSON.stringify({ outcome: result.outcome, activationId: result.activationId, runPath: result.runPath, finalResponse: result.finalResponse, terminalEnvelope: result.terminalEnvelope })}\n`); process.exitCode = result.outcome === 'DONE' ? 0 : 1
    }).catch(error => { process.stderr.write(`${error.code || 'RUNTIME_FAILURE'}: ${error.message}\n`); process.exitCode = 1 })
  } else { process.stderr.write('Reasonix supervisor requires an explicit activation request.\n'); process.exitCode = 2 }
}

module.exports = { PROFILE, configure, credentialEnvironment, launchActivation, prepareActivation, requestEnvelope, resolveAssignment, validateSelection, supervise }
