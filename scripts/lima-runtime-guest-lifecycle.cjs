#!/usr/bin/env node
'use strict'

// Durable guest-side request ownership.  A Lima shell is only a transport;
// this service owns the worker process group and persists its terminal receipt.
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const { GUEST_ROOT, status, parseRequest, providerConfiguration, targetPath } = require('./lima-runtime-guest.cjs')

const SOCKET = path.join(GUEST_ROOT, 'lifecycle.sock')
const RECORDS = path.join(GUEST_ROOT, 'requests')
const LOCK = path.join(GUEST_ROOT, 'lifecycle.lock')
const LOCK_GUARD = `${LOCK}.guard`
const MAX_FRAME = 1024 * 1024
const MAX_OUTPUT = 1024 * 1024
function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) fail('LIMA_REQUEST_INVALID', 'Request ID must contain exactly 32 lowercase hexadecimal characters')
  return value
}
function bootId() { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }
function privateDirectory(directory) {
  const item = fs.lstatSync(directory, { bigint: true })
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077n) !== 0n || fs.realpathSync(directory) !== directory) fail('LIMA_GUEST_UNSAFE', 'Lifecycle storage is not private')
}
function initialize() {
  privateDirectory(GUEST_ROOT)
  if (!fs.existsSync(RECORDS)) fs.mkdirSync(RECORDS, { mode: 0o700 })
  privateDirectory(RECORDS)
}
function recordPath(id) { return path.join(RECORDS, `${requestId(id)}.json`) }
function readRecord(id) {
  const file = recordPath(id)
  if (!fs.existsSync(file)) return null
  const item = fs.lstatSync(file, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', 'Lifecycle record is unsafe')
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('LIMA_GUEST_UNSAFE', 'Lifecycle record is invalid') }
  if (!value || value.schemaVersion !== 1 || value.requestId !== id || typeof value.bootId !== 'string' ||
      !['RUNNING', 'CANCELLATION_REQUESTED', 'CLI_EXITED', 'ACTIVATION_TERMINAL', 'FAILED'].includes(value.status)) fail('LIMA_GUEST_UNSAFE', 'Lifecycle record has an invalid shape')
  return value
}
function writeRecord(record, exclusive = false) {
  const file = recordPath(record.requestId)
  const body = JSON.stringify(record) + '\n'
  if (exclusive) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } else {
    const temporary = path.join(RECORDS, `.${record.requestId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
  }
  const directory = fs.openSync(RECORDS, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}
function publicStatus(id) {
  const record = readRecord(id), currentBoot = bootId()
  if (!record || record.bootId !== currentBoot || record.status === 'RUNNING' || record.status === 'CANCELLATION_REQUESTED') return { schemaVersion: 1, requestId: id, bootId: currentBoot, status: 'UNKNOWN' }
  return record
}
function parseFrame(line) {
  if (Buffer.byteLength(line) > MAX_FRAME) fail('LIMA_REQUEST_INVALID', 'Lifecycle frame exceeds the transport bound')
  let value
  try { value = JSON.parse(line) } catch { fail('LIMA_REQUEST_INVALID', 'Lifecycle frame is invalid JSON') }
  if (!value || typeof value !== 'object' || !['start', 'status', 'cancel', 'ping'].includes(value.op) ||
      Object.keys(value).some(key => !['op', 'requestId', 'argv', 'reason'].includes(key))) fail('LIMA_REQUEST_INVALID', 'Lifecycle frame contains unknown fields')
  if (value.op === 'ping' && Object.keys(value).length !== 1) fail('LIMA_REQUEST_INVALID', 'Lifecycle ping is invalid')
  if (value.op === 'status' || value.op === 'cancel') {
    requestId(value.requestId)
    if (value.argv !== undefined || (value.reason !== undefined && (value.op !== 'cancel' || typeof value.reason !== 'string' || value.reason.length > 128))) fail('LIMA_REQUEST_INVALID', 'Lifecycle request has unexpected arguments')
  }
  if (value.op === 'start') parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'exec', requestId: value.requestId, argv: value.argv })))
  return value
}
function terminal(record, statusValue, extra = {}) {
  return { ...record, status: statusValue, terminalAt: new Date().toISOString(), ...extra }
}
function outputPath(id) { return path.join(RECORDS, `${requestId(id)}.output.log`) }
function activationIntent(argv) {
  return Array.isArray(argv) && argv[0] === 'activate' && typeof argv[1] === 'string'
}
function activationBinding(argv) {
  if (!activationIntent(argv)) return null
  const requestSha256 = missionSha256(argv)
  if (!requestSha256) return null
  const index = argv.indexOf('--resume')
  const resumeActivationId = index >= 0 ? argv[index + 1] : null
  if (resumeActivationId !== null && !/^apv2-[a-f0-9]{32}$/.test(resumeActivationId || '')) return null
  return { missionSha256: requestSha256, ...(resumeActivationId ? { resumeActivationId } : {}) }
}
function missionSha256(argv) {
  const delimiter = argv.indexOf('--')
  if (delimiter < 0) return null
  return crypto.createHash('sha256').update(JSON.stringify({ schemaVersion: 1, argv: argv.slice(delimiter + 1) })).digest('hex')
}
function privateJson(file, label) {
  const item = fs.lstatSync(file, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', `${label} is unsafe`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('LIMA_GUEST_UNSAFE', `${label} is invalid`) }
}
function validateTerminalAgreement(state, providerTerminal, runtimeState) {
  const canonical = state.terminal
  const terminalFields = ['activationId', 'completedAt', 'deliverableManifestHash', 'generation', 'missionHash', 'outcome', 'requestEnvelopeHash', 'runId', 'schemaVersion', 'sequence', 'workspaceEpoch']
  if (!runtimeState.TERMINAL_STATES.includes(state.state) || !canonical || !runtimeState.validateCanonicalTerminalOutcome(canonical.terminalEnvelope) ||
      canonical.runId !== state.runId || canonical.outcome !== state.state ||
      terminalFields.some(field => canonical[field] !== providerTerminal[field]) ||
      JSON.stringify(providerTerminal.terminalEnvelope ?? null) !== JSON.stringify(canonical.terminalEnvelope ?? null)) {
    fail('LIMA_ACTIVATION_TERMINAL_UNPROVEN', 'Activation checksummed state and terminal receipt do not agree on one canonical terminal outcome')
  }
  return canonical.terminalEnvelope.payload.providerTerminal?.status || null
}
function validateActivationBinding(record, configuration, configuredTarget) {
  if (record.target?.realpath !== configuredTarget) fail('LIMA_ACTIVATION_RECEIPT_INVALID', 'Activation target does not match the configured guest binding')
  if (configuration.provider === 'codex') {
    if (record.activationBoundary?.providerApiBaseUrl !== configuration.endpoint) fail('LIMA_ACTIVATION_RECEIPT_INVALID', 'Codex provider endpoint does not match the configured guest binding')
  } else if (record.connectionSha256 !== configuration.connectionIdentitySha256) {
    fail('LIMA_ACTIVATION_RECEIPT_INVALID', 'Provider connection identity does not match the configured guest binding')
  }
}
function activationFinalized(record, provider, outcome) {
  const reasonixRecordFinalized = provider === 'reasonix' && record.status === 'revoked' &&
    Number.isFinite(Date.parse(record.revokedAt)) && record.outcome === outcome
  const capabilityFinalized = record.status === 'revoked' && record.capability?.status === 'revoked'
  return reasonixRecordFinalized || capabilityFinalized
}
function activationDirectory(configuration) {
  return configuration.provider === 'codex'
    ? path.join(GUEST_ROOT, 'providers', configuration.provider, '.a')
    : path.join(GUEST_ROOT, 'providers', configuration.provider, '.autoprompt-private', 'activations')
}
function cliFailureBeforeActivationReceipt(initial, exitCode, output, configuration, exists = fs.existsSync) {
  // A CLI can reject configuration before it creates any activation state.
  // Preserve that primary CLI failure and its captured output instead of
  // summarizing an activation directory that never existed.
  if (exitCode === 0 || exists(activationDirectory(configuration))) return null
  return terminal(initial, 'FAILED', {
    exitCode,
    output,
    errorCode: 'LIMA_ACTIVATION_CLI_FAILED',
    error: 'Activation CLI exited before creating a durable activation receipt',
  })
}
async function activationReceipt(initial) {
  if (!initial.activation) return null
  const configuration = providerConfiguration()
  const root = activationDirectory(configuration)
  const rootItem = fs.lstatSync(root, { bigint: true })
  if (!rootItem.isDirectory() || rootItem.isSymbolicLink() || (rootItem.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', 'Activation directory is unsafe')
  const candidates = []
  for (const name of fs.readdirSync(root)) {
    if (!/^apv2-[a-f0-9]{32}$/.test(name)) continue
    const activationRoot = path.join(root, name), item = fs.lstatSync(activationRoot, { bigint: true })
    if (!item.isDirectory() || item.isSymbolicLink()) continue
    const record = privateJson(path.join(activationRoot, 'activation.json'), 'Activation receipt')
    if (record.activationId !== name || record.request?.sha256 !== initial.activation.missionSha256 || typeof record.createdAt !== 'string' ||
        (initial.activation.resumeActivationId
          ? name !== initial.activation.resumeActivationId
          : Date.parse(record.createdAt) + 1000 < Date.parse(initial.startedAt))) continue
    candidates.push({ activationRoot, record })
  }
  if (candidates.length !== 1) fail('LIMA_ACTIVATION_RECEIPT_MISSING', 'Activation did not produce one exact receipt')
  const { activationRoot, record } = candidates[0]
  validateActivationBinding(record, configuration, targetPath())
  const runPath = record.supervisorRuntime?.runPath
  if (typeof runPath !== 'string' || !runPath.startsWith(activationRoot + '/r/')) fail('LIMA_ACTIVATION_RECEIPT_INVALID', 'Activation runtime binding is invalid')
  const packageRoot = path.join(GUEST_ROOT, 'install', 'node_modules', 'autoprompt-skill')
  const { readChecksummedJson } = require(path.join(packageRoot, 'agents', 'codex', 'workflow', 'event-log.js'))
  const { ProcessOwner, createPosixProcessAdapter } = require(path.join(packageRoot, 'agents', 'codex', 'workflow', 'process-owner.js'))
  const { TERMINAL_STATES, validateCanonicalTerminalOutcome } = require(path.join(packageRoot, 'agents', 'codex', 'workflow', 'runtime-state.js'))
  const processPath = path.join(runPath, 'runtime', 'processes.json')
  const statePath = path.join(runPath, 'runtime', 'state.json')
  const terminalPath = path.join(runPath, 'terminal.json')
  for (const [file, label] of [[processPath, 'Activation process receipt'], [statePath, 'Activation runtime state'], [terminalPath, 'Activation terminal receipt']]) {
    const item = fs.lstatSync(file, { bigint: true })
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', `${label} is unsafe`)
  }
  let processes, state, providerTerminal
  try { processes = readChecksummedJson(processPath); state = readChecksummedJson(statePath); providerTerminal = readChecksummedJson(terminalPath) }
  catch (error) { fail(error.code || 'LIMA_ACTIVATION_RECEIPT_INVALID', `Activation checksummed receipt is invalid: ${error.message}`) }
  const terminalStates = new Set(['DONE', 'PARTIAL', 'BLOCKED', 'CANCELLED', 'FAILED', 'LOST'])
  if (processes.schemaVersion !== 4 || processes.activationId !== record.activationId || !Array.isArray(processes.records) || !processes.records.length ||
      processes.records.some(entry => !terminalStates.has(entry?.status) || !terminalStates.has(entry?.terminal?.status))) {
    fail('LIMA_ACTIVATION_DRAIN_UNPROVEN', 'Activation does not have a complete owned-process drain receipt')
  }
  try {
    const owner = new ProcessOwner({ adapter: createPosixProcessAdapter(), registryPath: processPath,
      controlBinding: { activationId: processes.activationId, generationId: processes.generationId } })
    await owner.assertDrained()
  } catch (error) { fail(error.code || 'LIMA_ACTIVATION_DRAIN_UNPROVEN', `Activation ProcessOwner drain assertion failed: ${error.message}`) }
  const providerTerminalStatus = validateTerminalAgreement(state, providerTerminal, { TERMINAL_STATES, validateCanonicalTerminalOutcome })
  if (!activationFinalized(record, configuration.provider, state.state)) fail('LIMA_ACTIVATION_TERMINAL_UNPROVEN', 'Activation is not durably finalized')
  return { activationId: record.activationId, requestSha256: record.request.sha256, status: record.status, provider: configuration.provider,
    endpoint: configuration.endpoint, credentialSha256: configuration.credentialSha256, connectionIdentitySha256: configuration.connectionIdentitySha256,
    revokedAt: record.revokedAt, processReceiptSha256: crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex'), terminalReceiptSha256: crypto.createHash('sha256').update(fs.readFileSync(terminalPath)).digest('hex'),
    outcome: state.state, providerTerminalStatus,
    processCount: processes.records.length }
}
function createService() {
  initialize()
  const active = new Map()
  function finish(activeRequest, next) {
    if (activeRequest.finished) return
    activeRequest.finished = true
    clearTimeout(activeRequest.killTimer)
    writeRecord(next)
    active.delete(next.requestId)
    if (!activeRequest.socket.destroyed) activeRequest.socket.end(`${JSON.stringify({ type: 'terminal', record: next, ...(activeRequest.result === undefined ? {} : { result: activeRequest.result }) })}\n`)
  }
  function cancel(activeRequest, reason) {
    if (!activeRequest || activeRequest.finished || activeRequest.cancelling) return
    activeRequest.cancelling = true
    writeRecord({ ...activeRequest.record, status: 'CANCELLATION_REQUESTED', cancellationRequestedAt: new Date().toISOString(), cancellation: reason })
    try { process.kill(-activeRequest.worker.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    activeRequest.killTimer = setTimeout(() => {
      try { process.kill(-activeRequest.worker.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }, 5000).unref()
    activeRequest.cancelReason = reason
  }
  async function cancelledTerminal(activeRequest, code) {
    const output = activeRequest.outputReceipt()
    if (!activeRequest.record.activation) return finish(activeRequest, terminal(activeRequest.record, 'CLI_EXITED', { exitCode: code, output, cancellation: activeRequest.cancelReason }))
    try {
      const receipt = await activationReceipt(activeRequest.record)
      return finish(activeRequest, terminal(activeRequest.record, 'ACTIVATION_TERMINAL', { exitCode: code, output, cancellation: activeRequest.cancelReason, activation: receipt }))
    } catch (error) {
      return finish(activeRequest, terminal(activeRequest.record, 'FAILED', { exitCode: code, output, cancellation: activeRequest.cancelReason, errorCode: error.code || 'LIMA_ACTIVATION_RECEIPT_INVALID', error: error.message }))
    }
  }
  function start(socket, frame) {
    const commandSha256 = crypto.createHash('sha256').update(JSON.stringify(frame.argv)).digest('hex')
    const existing = readRecord(frame.requestId)
    if (existing) {
      if (existing.commandSha256 !== commandSha256) return socket.end(`${JSON.stringify({ type: 'error', code: 'LIMA_REQUEST_REPLAY_MISMATCH', message: 'A request ID cannot be replayed with different command arguments' })}\n`)
      return socket.end(`${JSON.stringify({ type: 'terminal', record: publicStatus(frame.requestId) })}\n`)
    }
    const activation = activationBinding(frame.argv)
    if (activation && !activation.missionSha256) return socket.end(`${JSON.stringify({ type: 'error', code: 'LIMA_REQUEST_INVALID', message: 'Activation requires mission arguments after --' })}\n`)
    const initial = { schemaVersion: 1, requestId: frame.requestId, bootId: bootId(), status: 'RUNNING', startedAt: new Date().toISOString(), commandSha256,
      ...(activation ? { activation } : {}) }
    writeRecord(initial, true)
    const output = outputPath(frame.requestId)
    const outputFd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    const worker = childProcess.fork(path.join(__dirname, 'lima-runtime-guest-worker.cjs'), [], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { HOME: '/home/autoprompt', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    })
    let outputBytes = 0, outputTruncated = false
    const capture = chunk => {
      const available = MAX_OUTPUT - outputBytes
      if (available > 0) {
        const part = chunk.length <= available ? chunk : chunk.subarray(0, available)
        fs.writeSync(outputFd, part); outputBytes += part.length
      }
      if (chunk.length > available) outputTruncated = true
    }
    worker.stdout.on('data', capture); worker.stderr.on('data', capture)
    const outputReceipt = () => {
      try { fs.fsyncSync(outputFd) } finally { fs.closeSync(outputFd) }
      return { path: path.relative(GUEST_ROOT, output), bytes: outputBytes, truncated: outputTruncated,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex') }
    }
    const activeRequest = { socket, worker, record: initial, finished: false, cancelling: false, killTimer: null, result: undefined, outputReceipt }
    active.set(frame.requestId, activeRequest)
    worker.once('message', message => {
      if (message?.type === 'result') activeRequest.result = message.result
      else if (message?.type === 'error') activeRequest.workerError = message
    })
    worker.once('exit', async code => {
      if (activeRequest.finished) return
      if (activeRequest.cancelling) return cancelledTerminal(activeRequest, code)
      const output = activeRequest.outputReceipt()
      if (activeRequest.workerError) return finish(activeRequest, terminal(initial, 'FAILED', { output, errorCode: activeRequest.workerError.code, error: activeRequest.workerError.message }))
      if (initial.activation) {
        try {
          const configuration = providerConfiguration()
          const cliFailure = cliFailureBeforeActivationReceipt(initial, code, output, configuration)
          if (cliFailure) return finish(activeRequest, cliFailure)
          const receipt = await activationReceipt(initial)
          return finish(activeRequest, terminal(initial, 'ACTIVATION_TERMINAL', { exitCode: code, output, activation: receipt }))
        } catch (error) {
          return finish(activeRequest, terminal(initial, 'FAILED', { exitCode: code, output, errorCode: error.code || 'LIMA_ACTIVATION_RECEIPT_INVALID', error: error.message }))
        }
      }
      // A CLI exit is only a transport-level terminal receipt.  It is never a
      // mission success or a process-drain certificate; activation remains
      // denied until its independently bound native receipts exist.
      if (code === 0) return finish(activeRequest, terminal(initial, 'CLI_EXITED', { exitCode: 0, output }))
      return finish(activeRequest, terminal(initial, 'FAILED', { errorCode: 'LIMA_GUEST_COMMAND_FAILED', exitCode: code, output }))
    })
    worker.send({ schemaVersion: 1, action: 'exec', requestId: frame.requestId, argv: frame.argv })
    socket.removeAllListeners('data')
    let cancellationFrame = ''
    socket.on('data', chunk => {
      cancellationFrame += chunk
      if (Buffer.byteLength(cancellationFrame) > MAX_FRAME) return socket.destroy()
      const newline = cancellationFrame.indexOf('\n')
      if (newline < 0) return
      try {
        const next = parseFrame(cancellationFrame.slice(0, newline))
        if (next.op !== 'cancel' || next.requestId !== frame.requestId || cancellationFrame.slice(newline + 1).trim()) fail('LIMA_REQUEST_INVALID', 'Lifecycle execution only accepts its own cancellation')
        cancel(activeRequest, next.reason || 'BRIDGE_CANCELLED')
      } catch { socket.destroy() }
    })
    socket.once('close', () => cancel(activeRequest, 'BRIDGE_DISCONNECTED'))
  }
  return net.createServer(socket => {
    socket.setEncoding('utf8')
    let buffered = '', handled = false
    socket.on('data', chunk => {
      if (handled) return
      buffered += chunk
      if (Buffer.byteLength(buffered) > MAX_FRAME) { socket.destroy(); return }
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      handled = true
      try {
        const frame = parseFrame(buffered.slice(0, newline))
        if (buffered.slice(newline + 1).trim()) fail('LIMA_REQUEST_INVALID', 'Lifecycle request must be one line')
        if (frame.op === 'ping') return socket.end('{"type":"pong"}\n')
        if (frame.op === 'status') return socket.end(`${JSON.stringify({ type: 'status', record: publicStatus(frame.requestId) })}\n`)
        if (frame.op === 'cancel') {
          cancel(active.get(frame.requestId), 'BRIDGE_CANCELLED')
          return socket.end(`${JSON.stringify({ type: 'status', record: readRecord(frame.requestId) || publicStatus(frame.requestId) })}\n`)
        }
        start(socket, frame)
      } catch (error) { socket.end(`${JSON.stringify({ type: 'error', code: error.code || 'LIMA_GUEST_FAILED', message: error.message })}\n`) }
    })
  })
}
function processIdentity(pid, readFileSync = fs.readFileSync) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('LIMA_GUEST_UNSAFE', 'Lifecycle process identity is invalid')
  const line = readFileSync(`/proc/${pid}/stat`, 'utf8').trim()
  const close = line.lastIndexOf(')')
  const fields = close >= 0 ? line.slice(close + 2).trim().split(/\s+/u) : []
  // The post-comm fields begin at stat field 3; starttime is field 22.
  const state = fields[0]
  const startTime = fields[19]
  if (!/^[A-Z]$/u.test(state || '') || !/^[0-9]+$/u.test(startTime || '')) fail('LIMA_GUEST_UNSAFE', 'Lifecycle process identity is invalid')
  return { startTime, state }
}
function processStartTime(pid, readFileSync = fs.readFileSync) { return processIdentity(pid, readFileSync).startTime }
function lockIdentity(options = {}) {
  const pid = options.pid ?? process.pid
  return { schemaVersion: 1, pid, startTime: (options.processStartTime || processStartTime)(pid), bootId: (options.bootId || bootId)(), nonce: (options.nonce || crypto.randomBytes(16).toString('hex')) }
}
function sameLockIdentity(left, right) {
  return !!left && !!right && left.schemaVersion === 1 && right.schemaVersion === 1 &&
    left.pid === right.pid && left.startTime === right.startTime && left.bootId === right.bootId && left.nonce === right.nonce
}
function validLockIdentity(value) {
  return !!value && value.schemaVersion === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.startTime === 'string' && /^[0-9]+$/u.test(value.startTime) &&
    typeof value.bootId === 'string' && /^[0-9a-f-]{36}$/u.test(value.bootId) &&
    typeof value.nonce === 'string' && /^[a-f0-9]{32}$/u.test(value.nonce) &&
    Object.keys(value).sort().join(',') === 'bootId,nonce,pid,schemaVersion,startTime'
}
function privateLockRecord(file, label, options = {}) {
  const fileSystem = options.fs || fs
  const item = fileSystem.lstatSync(file, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', `${label} is unsafe`)
  const body = fileSystem.readFileSync(file, 'utf8')
  let value
  try { value = JSON.parse(body) } catch { return { value: null, binding: { dev: item.dev, ino: item.ino, body } } }
  return { value, binding: { dev: item.dev, ino: item.ino, body } }
}
function sameBinding(left, right) { return !!left && !!right && left.dev === right.dev && left.ino === right.ino && left.body === right.body }
function exactLiveOwner(owner, options = {}) {
  if (!validLockIdentity(owner)) return false
  const currentBoot = (options.bootId || bootId)()
  if (owner.bootId !== currentBoot) return false
  try {
    const observed = options.processIdentity ? options.processIdentity(owner.pid) : options.processStartTime
      ? { startTime: options.processStartTime(owner.pid), state: 'R' }
      : processIdentity(owner.pid)
    return observed.startTime === owner.startTime && !['Z', 'X'].includes(observed.state)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
    throw error
  }
}
function writeExclusiveLock(file, identity, options = {}) {
  const fileSystem = options.fs || fs
  const descriptor = fileSystem.openSync(file, fileSystem.constants.O_WRONLY | fileSystem.constants.O_CREAT | fileSystem.constants.O_EXCL, 0o600)
  try { fileSystem.writeFileSync(descriptor, JSON.stringify(identity) + '\n'); fileSystem.fsyncSync(descriptor) } finally { fileSystem.closeSync(descriptor) }
}
async function withLockGuard(callback, options = {}) {
  const fileSystem = options.fs || fs
  const guard = options.guardPath || LOCK_GUARD
  if (!fileSystem.existsSync(guard)) {
    try {
      const descriptor = fileSystem.openSync(guard, fileSystem.constants.O_WRONLY | fileSystem.constants.O_CREAT | fileSystem.constants.O_EXCL, 0o600)
      fileSystem.closeSync(descriptor)
    } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const item = fileSystem.lstatSync(guard, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', 'Lifecycle lock guard is unsafe')
  const spawn = options.spawn || childProcess.spawn
  const child = spawn('/usr/bin/flock', ['-x', guard, '/bin/sh', '-ceu', "printf '%s\\n' ready; IFS= read -r _"], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  let closed = false
  const exited = new Promise(resolve => child.once('close', code => { closed = true; resolve(code) }))
  try {
    await new Promise((resolve, reject) => {
      let output = '', settled = false
      const settle = (fn, value) => { if (settled) return; settled = true; fn(value) }
      const failStart = error => settle(reject, Object.assign(error, { code: error.code || 'LIMA_LOCK_GUARD_UNAVAILABLE' }))
      child.once('error', failStart)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        output += chunk
        if (output === 'ready\n') { child.removeListener('error', failStart); settle(resolve) }
        else if (!'ready\n'.startsWith(output)) settle(reject, Object.assign(new Error('Lifecycle lock guard did not become ready'), { code: 'LIMA_LOCK_GUARD_UNAVAILABLE' }))
      })
      child.once('close', code => { if (output !== 'ready\n') settle(reject, Object.assign(new Error(`Lifecycle lock guard exited before readiness: ${code}`), { code: 'LIMA_LOCK_GUARD_UNAVAILABLE' })) })
    })
    if (closed) fail('LIMA_LOCK_GUARD_UNAVAILABLE', 'Lifecycle lock guard exited before ownership was acquired')
    return await callback()
  } finally {
    if (!child.stdin.destroyed) { child.stdin.once('error', () => {}); child.stdin.end('release\n') }
    await exited
  }
}
async function acquireLock(options = {}) {
  const fileSystem = options.fs || fs
  const lock = options.lockPath || LOCK
  const identity = (options.identity || (() => lockIdentity(options)))()
  const release = async () => withLockGuard(() => {
    if (!fileSystem.existsSync(lock)) return
    const current = privateLockRecord(lock, 'Lifecycle lock', { fs: fileSystem })
    if (sameLockIdentity(current.value, identity)) fileSystem.unlinkSync(lock)
  }, options)
  return withLockGuard(() => {
    if (!fileSystem.existsSync(lock)) { writeExclusiveLock(lock, identity, { fs: fileSystem }); return release }
    const current = privateLockRecord(lock, 'Lifecycle lock', { fs: fileSystem })
    if (exactLiveOwner(current.value, options)) return null
    // The bridge already failed to ping the service before calling serve(). A
    // malformed, legacy PID-only, wrong-boot, or reused-PID lock therefore
    // cannot prove an active controller and is replaced while flock serializes
    // every lock mutation.
    fileSystem.unlinkSync(lock)
    writeExclusiveLock(lock, identity, { fs: fileSystem })
    return release
  }, options)
}
async function serve() {
  initialize()
  const release = await acquireLock()
  if (!release) return
  if (fs.existsSync(SOCKET)) {
    const item = fs.lstatSync(SOCKET)
    if (!item.isSocket()) fail('LIMA_GUEST_UNSAFE', 'Lifecycle socket path is unsafe')
    fs.unlinkSync(SOCKET)
  }
  const server = createService()
  server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600))
  server.on('close', () => { release().catch(error => { process.stderr.write(`LIMA_LIFECYCLE_FAILED: ${error.message}\n`); process.exitCode = 2 }) })
  server.on('error', error => { release().catch(() => {}); process.stderr.write(`LIMA_LIFECYCLE_FAILED: ${error.message}\n`); process.exitCode = 2 })
}
if (require.main === module && process.argv.length === 3 && process.argv[2] === '--serve') serve().catch(error => { process.stderr.write(`${error.code || 'LIMA_LIFECYCLE_FAILED'}: ${error.message}\n`); process.exitCode = 2 })
module.exports = { SOCKET, RECORDS, requestId, parseFrame, activationBinding, validateTerminalAgreement, validateActivationBinding, activationFinalized, activationDirectory, cliFailureBeforeActivationReceipt, publicStatus, createService, acquireLock, processIdentity, processStartTime, lockIdentity, sameLockIdentity, exactLiveOwner, withLockGuard }
