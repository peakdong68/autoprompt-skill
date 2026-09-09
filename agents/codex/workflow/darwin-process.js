#!/usr/bin/env node
'use strict'

// The Darwin process helper is deliberately not wired into production yet.
// This wrapper binds one explicit Python and helper file, runs Python isolated,
// and accepts a closed result schema without returning process environments.

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateDarwinRuntimeClosure } = require('./darwin-runtime-closure.js')

const SCHEMA_VERSION = 1
const MAX_OUTPUT_BYTES = 128 * 1024
const MAX_HELPER_BYTES = 4 * 1024 * 1024
// A bundled CPython Mach-O executable can legitimately exceed the small,
// fixed helper limit.  It remains an exact physical-file binding, but is
// bounded independently to avoid making ordinary supported runtimes vanish.
const MAX_PYTHON_BYTES = 64 * 1024 * 1024
const RESERVATION_PATTERN = /^[A-Za-z0-9._:=+\-/]{1,2048}$/

class DarwinProcessError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DarwinProcessError'
    this.code = code
  }
}

function fail(code, message) { throw new DarwinProcessError(code, message) }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function checkedPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) fail('PROCESS_IDENTITY_INVALID', 'Darwin process identity requires a positive pid')
  return pid
}
function checkedReservation(value) {
  if (typeof value !== 'string' || !RESERVATION_PATTERN.test(value)) fail('PROCESS_IDENTITY_INVALID', 'Darwin reservation marker is invalid')
  return value
}
function physicalRegularFile(file, label, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('PROCESS_IDENTITY_INVALID', `${label} size limit is invalid`)
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('PROCESS_IDENTITY_INVALID', `${label} must be absolute`)
  let item
  try { item = fs.lstatSync(file) } catch { fail('PROCESS_IDENTITY_UNAVAILABLE', `${label} is unavailable`) }
  if (!item.isFile() || item.isSymbolicLink()) fail('PROCESS_IDENTITY_UNAVAILABLE', `${label} is not a physical regular file`)
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file)
  if (resolved !== file) fail('PROCESS_IDENTITY_UNAVAILABLE', `${label} physical path changed`)
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) fail('PROCESS_IDENTITY_UNAVAILABLE', `${label} physical identity is unsafe`)
  return Object.freeze({ path: resolved, sha256: sha256File(resolved), device: String(stat.dev), inode: String(stat.ino), size: stat.size, maxBytes })
}
function assertBinding(binding, label) {
  const current = physicalRegularFile(binding.path, label, binding.maxBytes)
  if (current.path !== binding.path || current.sha256 !== binding.sha256 || current.device !== binding.device || current.inode !== binding.inode || current.size !== binding.size) fail('PROCESS_IDENTITY_MISMATCH', `${label} changed after binding`)
  return current
}
function hashDescriptor(fd, size) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size))
  let offset = 0
  while (offset < size) {
    const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (length < 1) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin helper descriptor was truncated')
    hash.update(buffer.subarray(0, length)); offset += length
  }
  return hash.digest('hex')
}
function openBoundHelper(binding) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  let fd
  try {
    fd = fs.openSync(binding.path, flags)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || String(stat.dev) !== binding.device || String(stat.ino) !== binding.inode || stat.size !== binding.size || hashDescriptor(fd, stat.size) !== binding.sha256) fail('PROCESS_IDENTITY_MISMATCH', 'Darwin helper changed before execution')
    return fd
  } catch (error) {
    if (Number.isSafeInteger(fd)) fs.closeSync(fd)
    throw error
  }
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function parseResult(stdout) {
  if (typeof stdout !== 'string' || !stdout || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES || !stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer output is not one bounded JSON line')
  let result
  try { result = JSON.parse(stdout) } catch { fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer output is invalid JSON') }
  if (!result || result.schemaVersion !== SCHEMA_VERSION || typeof result.status !== 'string') fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer output is invalid')
  if (result.status === 'UNKNOWN') {
    if (!exactKeys(result, ['schemaVersion', 'status', 'reason']) || typeof result.reason !== 'string' || !/^[A-Z_]{3,80}$/.test(result.reason)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer unknown result is invalid')
    return Object.freeze(result)
  }
  if (result.status === 'DEAD') {
    if (!exactKeys(result, ['schemaVersion', 'status', 'pid']) || !Number.isSafeInteger(result.pid) || result.pid < 1) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer dead result is invalid')
    return Object.freeze(result)
  }
  if (result.status === 'LIVE') {
    const fields = ['schemaVersion', 'status', 'pid', 'ppid', 'uid', 'pgid', 'startSec', 'startUsec', 'bootSessionUuid', 'executablePath']
    if (!exactKeys(result, fields) || [result.pid, result.ppid, result.uid, result.pgid, result.startSec, result.startUsec].some(value => !Number.isSafeInteger(value) || value < 0) ||
        typeof result.bootSessionUuid !== 'string' || !/^[a-f0-9-]{36}$/.test(result.bootSessionUuid) ||
        typeof result.executablePath !== 'string' || !result.executablePath.startsWith('/') || /[\0\r\n]/.test(result.executablePath)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer live result is invalid')
    return Object.freeze(result)
  }
  if (result.status === 'OBSERVED') {
    if (!exactKeys(result, ['schemaVersion', 'status', 'matches']) || !Array.isArray(result.matches)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer reservation result is invalid')
    const seen = new Set()
    const matches = result.matches.map(entry => {
      const parsed = parseResult(JSON.stringify(entry) + '\n')
      if (parsed.status !== 'LIVE' || seen.has(parsed.pid)) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer reservation membership is invalid')
      seen.add(parsed.pid)
      return parsed
    })
    return Object.freeze({ ...result, matches: Object.freeze(matches) })
  }
  fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer result has an unsupported status')
}

function createDarwinProcessObserver(options = {}) {
  if (process.platform !== 'darwin') fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin process observer is unavailable on this platform')
  const python = physicalRegularFile(options.python, 'Darwin Python', MAX_PYTHON_BYTES)
  const helper = physicalRegularFile(options.helper || path.join(__dirname, 'darwin-process.py'), 'Darwin process helper', MAX_HELPER_BYTES)
  const runtimeClosure = options.runtimeClosure === undefined ? null : validateDarwinRuntimeClosure(options.runtimeClosure)
  if (runtimeClosure) {
    const [manifestPython, manifestHelper] = runtimeClosure.entries
    if (manifestPython.binding.path !== python.path || manifestPython.binding.sha256 !== python.sha256 ||
        manifestHelper.binding.path !== helper.path || manifestHelper.binding.sha256 !== helper.sha256) {
      fail('PROCESS_IDENTITY_MISMATCH', 'Darwin process runtime closure roots do not bind this invocation')
    }
  }
  const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) fail('PROCESS_IDENTITY_INVALID', 'Darwin observer timeout is invalid')
  const invoke = request => {
    // The helper itself is held through FD 3 and invoked through Darwin's
    // descriptor namespace.  Python's runtime closure is deliberately not
    // yet an admitted dependency closure; this unwired observer must not be
    // treated as production recovery authority until that is designed.
    assertBinding(python, 'Darwin Python')
    assertBinding(helper, 'Darwin process helper')
    if (runtimeClosure) validateDarwinRuntimeClosure(options.runtimeClosure)
    const helperFd = openBoundHelper(helper)
    try {
      const result = childProcess.spawnSync(python.path, ['-I', '-S', '-B', '/dev/fd/3', '--request'], {
        cwd: options.cwd || os.tmpdir(),
        env: { HOME: options.home || os.tmpdir(), LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
        encoding: 'utf8', input: JSON.stringify(request) + '\n', maxBuffer: MAX_OUTPUT_BYTES, shell: false, timeout: timeoutMs, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', helperFd],
      })
      assertBinding(python, 'Darwin Python')
      assertBinding(helper, 'Darwin process helper')
      if (runtimeClosure) validateDarwinRuntimeClosure(options.runtimeClosure)
      if (result.error || result.signal || result.status !== 0 || result.stderr) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer invocation failed')
      return parseResult(result.stdout)
    } finally { fs.closeSync(helperFd) }
  }
  const observe = pid => {
    const expectedPid = checkedPid(pid)
    const result = invoke({ schemaVersion: SCHEMA_VERSION, operation: 'observe', pid: expectedPid })
    if (result.status !== 'UNKNOWN' && result.pid !== expectedPid) fail('PROCESS_IDENTITY_UNAVAILABLE', 'Darwin observer returned a different pid')
    return result
  }
  const findReservation = reservation => invoke({ schemaVersion: SCHEMA_VERSION, operation: 'find-reservation', reservation: checkedReservation(reservation) })
  return Object.freeze({
    kind: 'darwin-libproc-v1',
    python,
    helper,
    runtimeClosure: runtimeClosure || undefined,
    observe,
    findReservation,
  })
}

module.exports = { DarwinProcessError, createDarwinProcessObserver, parseResult }
