#!/usr/bin/env node
'use strict'

// A Darwin helper cannot inherit trust merely because its interpreter happens
// to start.  This parser binds a release-produced, closed manifest to physical
// files before a helper is invoked. The controller-owned installation is the
// trust boundary: an untrusted workload must not be able to alter any manifest
// entry or its containing deployment. This is the same exact-identity model
// used by the portable runtime, rather than a claim about a global OS root.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_ENTRIES = 512
const SHA256 = /^[a-f0-9]{64}$/

class DarwinRuntimeClosureError extends Error {
  constructor(code, message) { super(message); this.name = 'DarwinRuntimeClosureError'; this.code = code }
}
function fail(code, message) { throw new DarwinRuntimeClosureError(code, message) }
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function physical(file, label, maxBytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail('DARWIN_RUNTIME_CLOSURE_INVALID', `${label} is invalid`)
  }
  let before
  try { before = fs.lstatSync(file) } catch { fail('DARWIN_RUNTIME_CLOSURE_UNAVAILABLE', `${label} is unavailable`) }
  if (!before.isFile() || before.isSymbolicLink()) fail('DARWIN_RUNTIME_CLOSURE_UNAVAILABLE', `${label} is not a physical regular file`)
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file)
  if (resolved !== file) fail('DARWIN_RUNTIME_CLOSURE_UNAVAILABLE', `${label} physical path changed`)
  const opened = fs.openSync(resolved, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(opened)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes ||
        String(stat.dev) !== String(before.dev) || String(stat.ino) !== String(before.ino) ||
        stat.mode !== before.mode || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) {
      fail('DARWIN_RUNTIME_CLOSURE_UNAVAILABLE', `${label} physical identity is unsafe`)
    }
    const digest = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, stat.size))
    for (let offset = 0; offset < stat.size;) {
      const count = fs.readSync(opened, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (count < 1) fail('DARWIN_RUNTIME_CLOSURE_UNAVAILABLE', `${label} was truncated`)
      digest.update(buffer.subarray(0, count)); offset += count
    }
    const after = fs.fstatSync(opened)
    const named = fs.lstatSync(resolved)
    if (String(after.dev) !== String(stat.dev) || String(after.ino) !== String(stat.ino) || after.size !== stat.size ||
        after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
        named.isSymbolicLink() || String(named.dev) !== String(stat.dev) || String(named.ino) !== String(stat.ino) ||
        named.mode !== stat.mode || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs) {
      fail('DARWIN_RUNTIME_CLOSURE_UNAVAILABLE', `${label} changed while bound`)
    }
    return Object.freeze({ path: resolved, sha256: digest.digest('hex'), device: String(stat.dev), inode: String(stat.ino), size: stat.size })
  } finally { fs.closeSync(opened) }
}
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function parseManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_MANIFEST_BYTES) fail('DARWIN_RUNTIME_CLOSURE_INVALID', 'Darwin runtime closure manifest size is invalid')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('DARWIN_RUNTIME_CLOSURE_INVALID', 'Darwin runtime closure manifest is invalid JSON') }
  if (!exact(value, ['schemaVersion', 'kind', 'entries']) || value.schemaVersion !== 1 || value.kind !== 'darwin-python-runtime-closure-v1' ||
      !Array.isArray(value.entries) || value.entries.length < 2 || value.entries.length > MAX_ENTRIES) fail('DARWIN_RUNTIME_CLOSURE_INVALID', 'Darwin runtime closure manifest shape is invalid')
  const seen = new Set()
  const entries = value.entries.map((entry, index) => {
    if (!exact(entry, ['role', 'path', 'sha256', 'maxBytes']) || !['python', 'helper', 'dependency'].includes(entry.role) ||
        typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !SHA256.test(entry.sha256) ||
        !Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > 1024 * 1024 * 1024 || seen.has(entry.path)) {
      fail('DARWIN_RUNTIME_CLOSURE_INVALID', 'Darwin runtime closure entry is invalid')
    }
    seen.add(entry.path); return Object.freeze({ ...entry, index })
  })
  if (entries.filter(entry => entry.role === 'python').length !== 1 || entries.filter(entry => entry.role === 'helper').length !== 1 ||
      entries.slice(0, 2).map(entry => entry.role).join(',') !== 'python,helper') fail('DARWIN_RUNTIME_CLOSURE_INVALID', 'Darwin runtime closure roots are invalid')
  return Object.freeze(entries)
}
function validateDarwinRuntimeClosure(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.manifest !== 'string' ||
      !path.isAbsolute(options.manifest) || !SHA256.test(options.manifestSha256 || '')) fail('DARWIN_RUNTIME_CLOSURE_INVALID', 'Darwin runtime closure manifest binding is required')
  const manifest = physical(options.manifest, 'Darwin runtime closure manifest', MAX_MANIFEST_BYTES)
  if (manifest.sha256 !== options.manifestSha256) fail('DARWIN_RUNTIME_CLOSURE_MISMATCH', 'Darwin runtime closure manifest changed from its trusted binding')
  const manifestBytes = fs.readFileSync(manifest.path)
  if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== manifest.sha256) {
    fail('DARWIN_RUNTIME_CLOSURE_MISMATCH', 'Darwin runtime closure manifest changed while read')
  }
  const afterManifest = physical(manifest.path, 'Darwin runtime closure manifest', MAX_MANIFEST_BYTES)
  if (afterManifest.sha256 !== manifest.sha256 || afterManifest.device !== manifest.device || afterManifest.inode !== manifest.inode ||
      afterManifest.size !== manifest.size) fail('DARWIN_RUNTIME_CLOSURE_MISMATCH', 'Darwin runtime closure manifest changed while parsed')
  const entries = parseManifest(manifestBytes)
  const bound = entries.map(entry => {
    const current = physical(entry.path, `Darwin runtime closure ${entry.role}`, entry.maxBytes)
    if (current.sha256 !== entry.sha256) fail('DARWIN_RUNTIME_CLOSURE_MISMATCH', `Darwin runtime closure ${entry.role} changed from manifest`)
    return Object.freeze({ ...entry, binding: current })
  })
  return Object.freeze({ kind: 'darwin-python-runtime-closure-v1', manifest, entries: Object.freeze(bound),
    trustModel: 'controller-owned-exact-runtime-closure-v1' })
}

module.exports = { DarwinRuntimeClosureError, validateDarwinRuntimeClosure, parseDarwinRuntimeClosureManifest: parseManifest }
