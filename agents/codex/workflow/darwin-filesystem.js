#!/usr/bin/env node
'use strict'

// Darwin capture adapter. The fixed helper owns directory authority;
// Node receives bounded metadata and hashes a private controller spool.
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateDarwinRuntimeClosure } = require('./darwin-runtime-closure.js')

const NATIVE_DARWIN = process.platform === 'darwin'
const MAX_HELPER_BYTES = 4 * 1024 * 1024
const MAX_PYTHON_BYTES = 64 * 1024 * 1024
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_OUTPUT_BYTES = 9 * 1024 * 1024
const MAX_CAPTURE_BYTES = 1024 * 1024 * 1024
const MAX_RECORD_BYTES = 8192
const MAX_PUBLICATION_BYTES = 8 * 1024 * 1024 + 1
const MAX_PUBLICATION_REQUEST = 12 * 1024 * 1024
const MAX_ENTRIES = 16384
const CHUNK = 1024 * 1024

class DarwinFilesystemError extends Error {
  constructor(code, message) { super(message); this.name = 'DarwinFilesystemError'; this.code = code }
}
function fail(code, message) { throw new DarwinFilesystemError(code, message) }
function exactKeys(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function safeNumber(value) { return Number.isSafeInteger(value) && value >= 0 }
function unsignedDecimal(value) { return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) }
function signedDecimal(value) { return typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/u.test(value) }
function samePhysicalStat(left, right) {
  return left && right && left.isFile() && right.isFile() &&
    String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino) &&
    left.mode === right.mode && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function shaDescriptor(descriptor, size) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size)))
  for (let offset = 0; offset < size;) {
    const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (read < 1) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'bound descriptor was truncated')
    hash.update(buffer.subarray(0, read)); offset += read
  }
  return hash.digest('hex')
}
function physicalRegularFile(filename, label, maxBytes) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('FILESYSTEM_BACKEND_INVALID', label + ' must be an absolute physical file')
  let before
  try { before = fs.lstatSync(filename) } catch { fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' is unavailable') }
  if (!before.isFile() || before.isSymbolicLink()) fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' is not a physical regular file')
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(filename) : fs.realpathSync(filename)
  if (resolved !== filename) fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' physical path changed')
  const named = fs.statSync(resolved)
  if (!samePhysicalStat(before, named) || named.nlink !== 1 || !Number.isSafeInteger(named.size) || named.size < 1 || named.size > maxBytes) {
    fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' physical identity is unsafe')
  }
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0))
  let opened
  let sha256
  try {
    opened = fs.fstatSync(descriptor)
    if (!samePhysicalStat(named, opened)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' changed while it was opened')
    sha256 = shaDescriptor(descriptor, opened.size)
    const after = fs.fstatSync(descriptor)
    const afterName = fs.lstatSync(resolved)
    const afterStat = fs.statSync(resolved)
    if (!samePhysicalStat(opened, after) || afterName.isSymbolicLink() || !samePhysicalStat(opened, afterStat)) {
      fail('FILESYSTEM_BACKEND_UNAVAILABLE', label + ' changed while it was bound')
    }
  } finally { fs.closeSync(descriptor) }
  return Object.freeze({ path: resolved, device: String(opened.dev), inode: String(opened.ino), size: opened.size, maxBytes, sha256 })
}
function assertBinding(binding, label) {
  const current = physicalRegularFile(binding.path, label, binding.maxBytes)
  if (current.path !== binding.path || current.device !== binding.device || current.inode !== binding.inode ||
      current.size !== binding.size || current.sha256 !== binding.sha256) {
    fail('FILESYSTEM_BACKEND_MISMATCH', label + ' changed after binding')
  }
}
function openBoundHelper(binding) {
  const descriptor = fs.openSync(binding.path, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || String(stat.dev) !== binding.device || String(stat.ino) !== binding.inode ||
        stat.size !== binding.size || shaDescriptor(descriptor, stat.size) !== binding.sha256) {
      fail('FILESYSTEM_BACKEND_MISMATCH', 'Darwin filesystem helper changed before execution')
    }
    return descriptor
  } catch (error) { fs.closeSync(descriptor); throw error }
}
function validRelative(value) {
  if (typeof value !== 'string' || /[\0]/u.test(value) || value.startsWith('/') || value.endsWith('/')) return false
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) return false
  return value === '' || value.split('/').every(part => part && part !== '.' && part !== '..')
}
function parseStat(stat) {
  const fields = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
  if (!exactKeys(stat, fields) || !unsignedDecimal(stat.dev) || !unsignedDecimal(stat.ino) || !safeNumber(stat.mode) || stat.mode > 0xffff ||
      !Number.isSafeInteger(stat.nlink) || stat.nlink < 1 || !safeNumber(stat.size) ||
      !signedDecimal(stat.mtimeNs) || !signedDecimal(stat.ctimeNs)) {
    fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem entry metadata is invalid')
  }
  return Object.freeze({ ...stat })
}
function parseCapture(stdout, operation) {
  if (!['capture-file', 'capture-tree'].includes(operation)) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem operation is invalid')
  if (typeof stdout !== 'string' || !stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n') ||
      Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem helper output is not one bounded JSON line')
  let value
  try { value = JSON.parse(stdout) } catch { fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem helper output is invalid JSON') }
  if (value && value.status === 'REFUSED') {
    if (!exactKeys(value, ['schemaVersion', 'status', 'code']) || value.schemaVersion !== 1 ||
        typeof value.code !== 'string' || !/^[A-Z_]{3,80}$/u.test(value.code)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem refusal is invalid')
    fail(value.code, 'Darwin filesystem helper refused capture')
  }
  if (!exactKeys(value, ['schemaVersion', 'status', 'bytes', 'entries']) || value.schemaVersion !== 1 ||
      value.status !== 'CAPTURED' || !safeNumber(value.bytes) || value.bytes > MAX_CAPTURE_BYTES ||
      !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_ENTRIES) {
    fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem capture output is invalid')
  }
  const seen = new Set()
  let offset = 0
  const entries = value.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !['file', 'directory'].includes(entry.type) ||
        !validRelative(entry.path) || seen.has(entry.path)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem entry is invalid')
    seen.add(entry.path)
    const stat = parseStat(entry.stat)
    const depth = entry.path ? entry.path.split('/').length : 0
    if (depth > 128) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem entry depth is invalid')
    if (entry.type === 'directory') {
      if (!exactKeys(entry, ['type', 'path', 'stat']) || (stat.mode & 0o170000) !== 0o040000) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem directory entry is invalid')
      return Object.freeze({ type: 'directory', path: entry.path, stat })
    }
    if (!exactKeys(entry, ['type', 'path', 'stat', 'offset', 'length']) || !safeNumber(entry.offset) ||
        !safeNumber(entry.length) || entry.offset !== offset || entry.length !== stat.size ||
        entry.length > value.bytes - offset || (stat.mode & 0o170000) !== 0o100000 || stat.nlink !== 1) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem file entry is invalid')
    offset += entry.length
    return Object.freeze({ type: 'file', path: entry.path, stat, offset: entry.offset, length: entry.length })
  })
  if (offset !== value.bytes || entries[0].path !== '' ||
      (operation === 'capture-file' && entries[0].type !== 'file') ||
      (operation === 'capture-tree' && entries[0].type !== 'directory') ||
      (operation === 'capture-file' && entries.length !== 1)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem capture framing is invalid')
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  for (const entry of entries) {
    if (!entry.path) continue
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    if (!byPath.has(parent) || byPath.get(parent).type !== 'directory') fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem capture ancestry is invalid')
  }
  return Object.freeze({ bytes: value.bytes, entries: Object.freeze(entries) })
}
function readSpool(descriptor, offset, length, consume) {
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, length)))
  for (let cursor = 0; cursor < length;) {
    const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, length - cursor), offset + cursor)
    if (read < 1) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem spool was truncated')
    consume(buffer.subarray(0, read)); cursor += read
  }
}
function digest(descriptor, capture, operation) {
  const hash = crypto.createHash('sha256')
  if (operation === 'capture-file') {
    const entry = capture.entries[0]
    readSpool(descriptor, entry.offset, entry.length, bytes => hash.update(bytes))
    return hash.digest('hex')
  }
  const children = new Map()
  for (const entry of capture.entries) {
    if (!entry.path) continue
    const separator = entry.path.lastIndexOf('/')
    const parent = separator < 0 ? '' : entry.path.slice(0, separator)
    const list = children.get(parent) || []
    list.push(entry)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort((left, right) => path.posix.basename(left.path).localeCompare(path.posix.basename(right.path)))
  const visit = relative => {
    for (const entry of children.get(relative) || []) {
      const mode = entry.stat.mode & 0o777
      if (entry.type === 'directory') { hash.update('directory\0' + entry.path + '\0' + mode + '\0'); visit(entry.path) } else {
        hash.update('file\0' + entry.path + '\0' + mode + '\0' + entry.length + '\0')
        readSpool(descriptor, entry.offset, entry.length, bytes => hash.update(bytes)); hash.update('\0')
      }
    }
  }
  visit('')
  return hash.digest('hex')
}
function privateSpool() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-darwin-capture-'))
  let descriptor
  try {
    fs.chmodSync(directory, 0o700)
    descriptor = fs.openSync(path.join(directory, 'spool'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600)
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 0 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
      fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem spool is not private')
    }
    return { directory, descriptor, stat }
  } catch (error) {
    if (Number.isInteger(descriptor)) fs.closeSync(descriptor)
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
function assertSpool(descriptor, initial, bytes) {
  const stat = fs.fstatSync(descriptor)
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== initial.uid || String(stat.dev) !== String(initial.dev) ||
      String(stat.ino) !== String(initial.ino) || stat.mode !== initial.mode || stat.size !== bytes) {
    fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem spool changed unexpectedly')
  }
}
function canonicalAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/u.test(value)) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem path must be absolute')
  const resolved = path.resolve(value)
  if (resolved !== value || resolved === path.parse(resolved).root) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem path is not canonical')
  return resolved
}
function mutationComponents(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128 || value.some(part => typeof part !== 'string' || !part || part === '.' || part === '..' || /[\0/]/u.test(part) || Buffer.from(part, 'utf8').toString('utf8') !== part)) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem components are invalid')
  return value.slice()
}
function parseMutation(stdout, expected, expectedBytes, maximum = MAX_RECORD_BYTES) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n') || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem mutation output is invalid')
  let value; try { value = JSON.parse(stdout) } catch { fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem mutation output is invalid JSON') }
  if (value && value.status === 'REFUSED') {
    if (!exactKeys(value, ['schemaVersion', 'status', 'code']) || value.schemaVersion !== 1 || typeof value.code !== 'string' || !/^[A-Z_]{3,80}$/u.test(value.code)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem mutation refusal is invalid')
    fail(value.code, 'Darwin filesystem helper refused mutation')
  }
  if (expected === 'REMOVED') {
    if (!exactKeys(value, ['schemaVersion', 'status']) || value.schemaVersion !== 1 || !['REMOVED', 'ABSENT'].includes(value.status)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin cleanup result is invalid')
    return Object.freeze({ removed: value.status === 'REMOVED' })
  }
  if (expected === 'INSPECTED') {
    const parent = value && value.parentIdentity, target = value && value.targetIdentity
    if (!exactKeys(value, ['schemaVersion', 'status', 'parentIdentity', 'targetIdentity']) || value.schemaVersion !== 1 || value.status !== expected ||
        !exactKeys(parent, ['dev', 'ino']) || !exactKeys(target, ['type', 'dev', 'ino']) || !['file', 'directory'].includes(target.type) ||
        ![parent.dev, parent.ino, target.dev, target.ino].every(unsignedDecimal)) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin cleanup identities are invalid')
    return Object.freeze({ parentIdentity: Object.freeze(parent), targetIdentity: Object.freeze(target) })
  }
  if (expected === 'RECOVERED') {
    if (!exactKeys(value, ['schemaVersion', 'status', 'removed']) || value.schemaVersion !== 1 || value.status !== expected ||
        !Array.isArray(value.removed) || value.removed.length > MAX_ENTRIES || new Set(value.removed).size !== value.removed.length ||
        value.removed.some(name => typeof name !== 'string' || /[\0/]/u.test(name) || !/^\..+\.[1-9][0-9]*\.[a-f0-9]{16}\.(?:create|tmp)$/u.test(name))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem recovery response is invalid')
    return Object.freeze(value.removed.slice())
  }
  if (!exactKeys(value, ['schemaVersion', 'status', 'stat']) || value.schemaVersion !== 1 || value.status !== expected) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem mutation response is invalid')
  const stat = parseStat(value.stat)
  if (expected === 'VALIDATED') {
    if ((stat.mode & 0o170000) !== 0o040000 || stat.nlink < 1) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem parent stat is invalid')
    return Object.freeze({ stat })
  }
  if ((stat.mode & 0o170000) !== 0o100000 || stat.nlink !== 1 || stat.size > maximum ||
      (expected === 'CREATED' && ((stat.mode & 0o777) !== 0o600 || stat.size !== expectedBytes))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem mutation stat is invalid')
  return Object.freeze({ stat })
}
function createDarwinFilesystemCapture(options = {}) {
  if (!NATIVE_DARWIN) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem capture is unavailable on this platform')
  const python = physicalRegularFile(options.python, 'Darwin Python', MAX_PYTHON_BYTES)
  const helper = physicalRegularFile(options.helper || path.join(__dirname, 'darwin-filesystem.py'), 'Darwin filesystem helper', MAX_HELPER_BYTES)
  const runtimeClosure = options.runtimeClosure === undefined ? null : validateDarwinRuntimeClosure(options.runtimeClosure)
  if (runtimeClosure) {
    const [manifestPython, manifestHelper] = runtimeClosure.entries
    if (manifestPython.binding.path !== python.path || manifestPython.binding.sha256 !== python.sha256 ||
        manifestHelper.binding.path !== helper.path || manifestHelper.binding.sha256 !== helper.sha256) {
      fail('FILESYSTEM_BACKEND_MISMATCH', 'Darwin filesystem runtime closure roots do not bind this invocation')
    }
  }
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem timeout is invalid')
  const invoke = (operation, absolute, includeBytes = false) => {
    const target = canonicalAbsolute(absolute)
    const input = JSON.stringify({ schemaVersion: 1, operation, path: target })
    if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem request is too large')
    assertBinding(python, 'Darwin Python'); assertBinding(helper, 'Darwin filesystem helper')
    if (runtimeClosure) validateDarwinRuntimeClosure(options.runtimeClosure)
    const spool = privateSpool()
    let helperDescriptor
    try {
      helperDescriptor = openBoundHelper(helper)
      const result = cp.spawnSync(python.path, ['-I', '-S', '-B', '/dev/fd/4', '--request'], {
        cwd: options.cwd || spool.directory, env: { HOME: spool.directory, LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
        encoding: 'utf8', input, maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', spool.descriptor, helperDescriptor],
      })
      assertBinding(python, 'Darwin Python'); assertBinding(helper, 'Darwin filesystem helper')
      if (runtimeClosure) validateDarwinRuntimeClosure(options.runtimeClosure)
      if (result.error || result.signal || result.status !== 0 || result.stderr) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem helper invocation failed')
      let capture
      try { capture = parseCapture(result.stdout, operation) } catch (error) {
        if (error && error.code === 'FILESYSTEM_NOT_FOUND') error.code = 'ENOENT'
        throw error
      }
      assertSpool(spool.descriptor, spool.stat, capture.bytes)
      const hash = digest(spool.descriptor, capture, operation)
      assertSpool(spool.descriptor, spool.stat, capture.bytes)
      let content
      if (includeBytes) {
        if (operation !== 'capture-file') fail('FILESYSTEM_BACKEND_INVALID', 'only Darwin file capture can return bytes')
        content = Buffer.allocUnsafe(capture.bytes)
        for (let offset = 0; offset < content.length;) {
          const read = fs.readSync(spool.descriptor, content, offset, content.length - offset, offset)
          if (read < 1) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem spool was truncated')
          offset += read
        }
      }
      return Object.freeze({ hash, bytes: capture.bytes, entries: capture.entries, ...(content ? { content } : {}) })
    } finally {
      if (Number.isInteger(helperDescriptor)) fs.closeSync(helperDescriptor)
      fs.closeSync(spool.descriptor); fs.rmSync(spool.directory, { recursive: true, force: true })
    }
  }
  return Object.freeze({
    kind: 'darwin-dirfd-capture-v1', python, helper, runtimeClosure: runtimeClosure || undefined,
    captureFile: absolute => invoke('capture-file', absolute),
    captureFileBytes: absolute => invoke('capture-file', absolute, true),
    captureTree: absolute => invoke('capture-tree', absolute),
  })
}
function createDarwinFilesystemMutations(options = {}) {
  if (!NATIVE_DARWIN) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem mutations are unavailable on this platform')
  const python = physicalRegularFile(options.python, 'Darwin Python', MAX_PYTHON_BYTES)
  const helper = physicalRegularFile(options.helper || path.join(__dirname, 'darwin-filesystem.py'), 'Darwin filesystem helper', MAX_HELPER_BYTES)
  const runtimeClosure = options.runtimeClosure === undefined ? null : validateDarwinRuntimeClosure(options.runtimeClosure)
  if (runtimeClosure) {
    const [manifestPython, manifestHelper] = runtimeClosure.entries
    if (manifestPython.binding.path !== python.path || manifestPython.binding.sha256 !== python.sha256 ||
        manifestHelper.binding.path !== helper.path || manifestHelper.binding.sha256 !== helper.sha256) {
      fail('FILESYSTEM_BACKEND_MISMATCH', 'Darwin filesystem runtime closure roots do not bind this invocation')
    }
  }
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem timeout is invalid')
  // A REFUSED result may follow a successful create or rename whose final
  // verification observed a concurrent change. This primitive has no rollback
  // authority; callers must quiesce writers and mutable ancestors. Its fsyncs
  // cover process-crash durability, not a power-loss guarantee (no F_FULLFSYNC).
  const invoke = (request, expected, expectedBytes) => {
    const input = JSON.stringify(request)
    const publication = request.operation === 'publish-record-exclusive'
    if (Buffer.byteLength(input, 'utf8') > (publication ? MAX_PUBLICATION_REQUEST : MAX_REQUEST_BYTES)) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem request is too large')
    assertBinding(python, 'Darwin Python'); assertBinding(helper, 'Darwin filesystem helper')
    if (runtimeClosure) validateDarwinRuntimeClosure(options.runtimeClosure)
    let helperDescriptor
    try {
      helperDescriptor = openBoundHelper(helper)
      const result = cp.spawnSync(python.path, ['-I', '-S', '-B', '/dev/fd/4', '--request'], { cwd: options.cwd || os.tmpdir(), env: { HOME: os.tmpdir(), LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }, encoding: 'utf8', input, maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ignore', helperDescriptor] })
      assertBinding(python, 'Darwin Python'); assertBinding(helper, 'Darwin filesystem helper')
      if (runtimeClosure) validateDarwinRuntimeClosure(options.runtimeClosure)
      if (result.error || result.signal || result.status !== 0 || result.stderr) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem helper invocation failed')
      try { return parseMutation(result.stdout, expected, expectedBytes, publication ? MAX_PUBLICATION_BYTES : MAX_RECORD_BYTES) } catch (error) {
        if (error && error.code === 'FILESYSTEM_ALREADY_EXISTS') error.code = 'EEXIST'
        if (error && error.code === 'FILESYSTEM_NOT_FOUND') error.code = 'ENOENT'
        throw error
      }
    } finally { if (Number.isInteger(helperDescriptor)) fs.closeSync(helperDescriptor) }
  }
  return Object.freeze({
    kind: 'darwin-dirfd-mutation-v1', python, helper, runtimeClosure: runtimeClosure || undefined,
    inspectOwnedTarget: absolute => {
      const target = canonicalAbsolute(absolute)
      return invoke({ schemaVersion: 1, operation: 'inspect-owned-target', root: '/',
        components: mutationComponents(target.slice(1).split('/')) }, 'INSPECTED')
    },
    removeOwnedTarget: (absolute, expectedParent, expectedTarget) => {
      const target = canonicalAbsolute(absolute)
      if (!exactKeys(expectedParent, ['dev', 'ino']) || !exactKeys(expectedTarget, ['type', 'dev', 'ino']) ||
          !['file', 'directory'].includes(expectedTarget.type) || ![expectedParent.dev, expectedParent.ino, expectedTarget.dev, expectedTarget.ino].every(unsignedDecimal)) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin cleanup identity binding is invalid')
      return invoke({ schemaVersion: 1, operation: 'remove-owned-target', root: '/',
        components: mutationComponents(target.slice(1).split('/')), expectedParent, expectedTarget }, 'REMOVED')
    },
    recoverRecordPublication: absolute => {
      const target = canonicalAbsolute(absolute)
      const removed = invoke({ schemaVersion: 1, operation: 'recover-record-publication', root: '/',
        components: mutationComponents(target.slice(1).split('/')) }, 'RECOVERED')
      const prefix = `.${path.basename(target)}.`
      if (removed.some(name => !name.startsWith(prefix))) fail('FILESYSTEM_BACKEND_UNAVAILABLE', 'Darwin filesystem recovered a foreign publication')
      return removed
    },
    assertRecordParent: absolute => {
      const target = canonicalAbsolute(absolute)
      return invoke({ schemaVersion: 1, operation: 'assert-record-parent', root: '/',
        components: mutationComponents(target.slice(1).split('/')) }, 'VALIDATED')
    },
    publishRecordExclusive: (absolute, bytes) => {
      const target = canonicalAbsolute(absolute)
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PUBLICATION_BYTES) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem record bytes are invalid')
      return invoke({ schemaVersion: 1, operation: 'publish-record-exclusive', root: '/',
        components: mutationComponents(target.slice(1).split('/')), bytesBase64: bytes.toString('base64') }, 'CREATED', bytes.length)
    },
    writeRecordExclusive: (root, components, bytes) => {
      const data = Buffer.isBuffer(bytes) ? bytes : null
      if (!data || data.length > MAX_RECORD_BYTES) fail('FILESYSTEM_BACKEND_INVALID', 'Darwin filesystem record bytes are invalid')
      return invoke({ schemaVersion: 1, operation: 'write-record-exclusive', root: canonicalAbsolute(root), components: mutationComponents(components), bytesBase64: data.toString('base64') }, 'CREATED', data.length)
    },
    renameNoReplace: (sourceRoot, sourceComponents, targetRoot, targetComponents) => invoke({ schemaVersion: 1, operation: 'rename-no-replace', sourceRoot: canonicalAbsolute(sourceRoot), sourceComponents: mutationComponents(sourceComponents), targetRoot: canonicalAbsolute(targetRoot), targetComponents: mutationComponents(targetComponents) }, 'RENAMED'),
  })
}
module.exports = { DarwinFilesystemError, createDarwinFilesystemCapture, createDarwinFilesystemMutations, parseCapture, parseMutation }
