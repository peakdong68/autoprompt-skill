'use strict'

// A VS Code extension host needs an X display even when the guest itself has
// no desktop session.  This helper starts one private, authenticated Xvfb as a
// child of the already-owned guest worker.  It never adopts a host DISPLAY and
// it is stopped before the worker reports its terminal result.
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

const DISPLAY_MIN = 90
const DISPLAY_COUNT = 32
const READY_TIMEOUT_MS = 5000
const READY_PROBE_TIMEOUT_MS = 2000
const SLOT_LOCK_TIMEOUT_MS = 5000
function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function privateDirectory(directory) {
  const item = fs.lstatSync(directory, { bigint: true })
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077n) !== 0n || fs.realpathSync(directory) !== directory) fail('LIMA_GUEST_UNSAFE', 'VS Code display storage must be a private physical directory')
}
function privateExecutable(file, label) {
  let item
  try { item = fs.lstatSync(file, { bigint: true }) } catch { fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', `${label} is unavailable in this guest`) }
  if (!item.isFile() || item.isSymbolicLink() || (item.mode & 0o022n) !== 0n) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', `${label} is not a safe system executable`)
  try { fs.accessSync(file, fs.constants.X_OK) } catch { fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', `${label} is not executable`) }
  return file
}
function requestDisplay(requestId) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) fail('LIMA_REQUEST_INVALID', 'VS Code display needs the exact lifecycle request identity')
  return DISPLAY_MIN + (Number.parseInt(requestId.slice(0, 8), 16) % DISPLAY_COUNT)
}
function processStartTicks(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ')[21] || null } catch { return null }
}
function displayPaths(root, requestId) {
  if (!path.isAbsolute(root)) fail('LIMA_GUEST_UNSAFE', 'VS Code display root must be absolute')
  const base = path.join(root, 'displays', requestId)
  // VS Code puts its main-process IPC socket in XDG_RUNTIME_DIR.  Keep that
  // path deliberately short: Unix-domain socket names are capped at 108 bytes.
  // The reserved display number is unique while a worker owns it, so it is a
  // safe private runtime-directory component without carrying the 32-byte
  // lifecycle ID into every socket path.
  return { base, auth: path.join(base, 'Xauthority'), runtimeRoot: path.join(root, 'd'), slots: path.join(root, 'display-slots') }
}
function socketPath(display) { return path.join('/tmp/.X11-unix', `X${display}`) }
function lockPath(display) { return path.join('/tmp', `.X${display}-lock`) }
function unusedDisplay(display) { return !fs.existsSync(socketPath(display)) && !fs.existsSync(lockPath(display)) }
function reservationIdentity(item) { return { dev: String(item.dev), ino: String(item.ino) } }
function releaseSlot(file, body, identity, { strict = true } = {}) {
  try {
    const item = fs.lstatSync(file, { bigint: true })
    const same = item.isFile() && !item.isSymbolicLink() && item.nlink === 1n && (item.mode & 0o077n) === 0n &&
      reservationIdentity(item).dev === identity.dev && reservationIdentity(item).ino === identity.ino && fs.readFileSync(file, 'utf8') === body
    if (!same) {
      if (strict) fail('LIMA_GUEST_UNSAFE', 'VS Code display reservation changed before release')
      return false
    }
    fs.unlinkSync(file)
    return true
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function createPrivateFile(file) {
  try {
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.closeSync(descriptor)
  } catch (error) { if (error.code !== 'EEXIST') throw error }
  const item = fs.lstatSync(file, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', 'VS Code display lock is unsafe')
}
async function withSlotLock(paths, work, flockPath = '/usr/bin/flock') {
  privateExecutable(flockPath, 'flock')
  createPrivateFile(path.join(paths.slots, '.lock'))
  // flock owns the kernel lock while its tiny shell waits for our private pipe
  // to close.  That lets this worker perform the filesystem critical section
  // without exposing a check-then-unlink window to another worker.
  const child = childProcess.spawn(flockPath, ['-x', '-w', String(SLOT_LOCK_TIMEOUT_MS / 1000), path.join(paths.slots, '.lock'), '/bin/sh', '-c', 'printf "\\036"; IFS= read -r _ || true'], { detached: false, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } })
  let spawnError, stdinError, output = ''
  child.once('error', error => { spawnError = error })
  child.stdin.once('error', error => { stdinError = error })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', value => { output += value.toString('utf8'); if (output.includes('\x1e')) resolve() })
    child.once('exit', (code, signal) => reject(Object.assign(new Error(`VS Code display lock exited before acquisition (${code ?? signal})`), { code: 'LIMA_VSCODE_DISPLAY_UNAVAILABLE' })))
    setTimeout(() => reject(Object.assign(new Error('VS Code display lock did not become ready'), { code: 'LIMA_VSCODE_DISPLAY_UNAVAILABLE' })), SLOT_LOCK_TIMEOUT_MS + 500).unref()
  })
  try {
    await ready
    if (spawnError || stdinError || !Number.isSafeInteger(child.pid)) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', `VS Code display lock failed: ${(spawnError || stdinError)?.code || 'no child identity'}`)
    return await work()
  } finally {
    if (child.exitCode === null && child.signalCode === null && Number.isSafeInteger(child.pid)) {
      try { child.stdin.end('\n') } catch (error) { stdinError ||= error }
      await Promise.race([exited, delay(2000)])
    }
    if (child.exitCode === null && child.signalCode === null && Number.isSafeInteger(child.pid)) {
      try { child.kill('SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await Promise.race([exited, delay(2000)])
    }
    if (Number.isSafeInteger(child.pid) && child.exitCode === null && child.signalCode === null) fail('LIMA_VSCODE_DISPLAY_UNDRAINED', 'VS Code display lock did not exit after its critical section')
  }
}
async function reserveDisplay(paths, requestId) {
  fs.mkdirSync(paths.slots, { recursive: true, mode: 0o700 }); privateDirectory(paths.slots)
  const startTicks = processStartTicks(process.pid)
  if (!startTicks) fail('LIMA_GUEST_UNSAFE', 'VS Code display worker has no stable process identity')
  const body = JSON.stringify({ schemaVersion: 1, requestId, pid: process.pid, startTicks }) + '\n'
  return await withSlotLock(paths, async () => {
    const first = requestDisplay(requestId)
    for (let index = 0; index < DISPLAY_COUNT; index += 1) {
      const display = DISPLAY_MIN + ((first - DISPLAY_MIN + index) % DISPLAY_COUNT)
      if (!unusedDisplay(display)) continue
      const file = path.join(paths.slots, String(display))
      try {
        const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
        try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
        const identity = reservationIdentity(fs.lstatSync(file, { bigint: true }))
        return { display, release: async () => await withSlotLock(paths, async () => releaseSlot(file, body, identity)) }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const item = fs.lstatSync(file, { bigint: true }), originalIdentity = reservationIdentity(item), original = fs.readFileSync(file, 'utf8')
        let record
        try { record = JSON.parse(original) } catch { fail('LIMA_GUEST_UNSAFE', 'VS Code display reservation is invalid') }
        if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n || !/^\d+$/.test(String(record?.pid)) || typeof record.startTicks !== 'string') fail('LIMA_GUEST_UNSAFE', 'VS Code display reservation is unsafe')
        if (processStartTicks(record.pid) !== record.startTicks) releaseSlot(file, original, originalIdentity, { strict: false })
      }
    }
    fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', 'No private Xvfb display slot is available')
  })
}
function safeWrite(file, content) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}
function xauthCookie(xauth, auth, display, cookie, env) {
  safeWrite(auth, '')
  const result = childProcess.spawnSync(xauth, ['-f', auth, 'add', `:${display}`, '.', cookie], { shell: false, encoding: 'utf8', timeout: 5000, env })
  if (result.error || result.status !== 0) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', 'xauth could not bind the private Xvfb cookie')
  const item = fs.lstatSync(auth, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n || item.size < 16n) fail('LIMA_GUEST_UNSAFE', 'VS Code Xauthority file is unsafe')
}
async function stopOwnedDisplay(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise(resolve => child.once('exit', resolve))
  try { child.kill('SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await Promise.race([ended, delay(2000)])
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await Promise.race([ended, delay(2000)])
  }
  if (child.exitCode === null && child.signalCode === null) fail('LIMA_VSCODE_DISPLAY_UNDRAINED', 'Owned Xvfb did not exit after bounded shutdown')
}
function probeAuthenticatedDisplay(probe, environment) {
  const result = childProcess.spawnSync(probe, ['-display', environment.DISPLAY], { shell: false, encoding: 'utf8', timeout: READY_PROBE_TIMEOUT_MS, env: { ...environment, PATH: '/usr/local/bin:/usr/bin:/bin' } })
  return !result.error && result.status === 0
}
async function startOwnedDisplay({ root, requestId, xvfbPath = '/usr/bin/Xvfb', xauthPath = '/usr/bin/xauth', probePath = '/usr/bin/xdpyinfo' }) {
  privateDirectory(root)
  const xvfb = privateExecutable(xvfbPath, 'Xvfb'), xauth = privateExecutable(xauthPath, 'xauth'), probe = privateExecutable(probePath, 'xdpyinfo')
  const paths = displayPaths(root, requestId)
  fs.mkdirSync(path.dirname(paths.base), { recursive: true, mode: 0o700 })
  privateDirectory(path.dirname(paths.base))
  if (fs.existsSync(paths.base)) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', 'This lifecycle request already has display storage')
  fs.mkdirSync(paths.base, { mode: 0o700 })
  privateDirectory(paths.base)
  const reservation = await reserveDisplay(paths, requestId)
  const display = reservation.display
  const runtime = path.join(paths.runtimeRoot, String(display))
  try {
    fs.mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 })
    privateDirectory(paths.runtimeRoot)
    if (fs.existsSync(runtime)) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', 'Reserved VS Code runtime directory is not clean')
    fs.mkdirSync(runtime, { mode: 0o700 })
    privateDirectory(runtime)
  } catch (error) {
    await reservation.release()
    throw error
  }
  const launchEnvironment = { HOME: root, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime }
  try { xauthCookie(xauth, paths.auth, display, crypto.randomBytes(32).toString('hex'), launchEnvironment) }
  catch (error) {
    try { fs.rmSync(runtime, { recursive: true, force: true }) } finally { await reservation.release() }
    throw error
  }
  const environment = { DISPLAY: `:${display}`, XAUTHORITY: paths.auth, XDG_RUNTIME_DIR: runtime }
  const child = childProcess.spawn(xvfb, [`:${display}`, '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-auth', paths.auth], { detached: false, stdio: 'ignore', env: launchEnvironment })
  let spawnError
  child.once('error', error => { spawnError = error })
  try {
    const readyAt = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < readyAt) {
      if (spawnError) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', `Owned Xvfb failed to start: ${spawnError.code || spawnError.message}`)
      if (child.exitCode !== null || child.signalCode !== null) fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', 'Owned Xvfb exited before becoming ready')
      try {
        if (fs.lstatSync(socketPath(display)).isSocket() && probeAuthenticatedDisplay(probe, environment)) {
          return {
            child,
            environment,
            async stop() {
              await stopOwnedDisplay(child)
              let cleanupError
              try { fs.rmSync(runtime, { recursive: true, force: false }) } catch (error) { cleanupError = error }
              try { await reservation.release() } catch (error) { if (!cleanupError) cleanupError = error }
              if (cleanupError) throw Object.assign(new Error(`Owned VS Code runtime cleanup failed: ${cleanupError.message}`), { code: 'LIMA_VSCODE_DISPLAY_UNDRAINED', cause: cleanupError })
            }
          }
        }
      } catch { /* socket or authenticated probe is not ready */ }
      await delay(25)
    }
    fail('LIMA_VSCODE_DISPLAY_UNAVAILABLE', 'Owned Xvfb did not create an authenticated display socket')
  } catch (error) {
    try { await stopOwnedDisplay(child) }
    catch (stopError) {
      // Do not release a slot that may still have an owned X server.  Surface
      // both failures so the lifecycle cannot report a clean display failure
      // while a child remains alive.
      throw Object.assign(new Error(`Owned Xvfb readiness failed (${error.code || error.message}) and its shutdown failed (${stopError.code || stopError.message})`), { code: 'LIMA_VSCODE_DISPLAY_UNDRAINED', cause: error, cleanupError: stopError })
    }
    try { fs.rmSync(runtime, { recursive: true, force: true }) } finally { await reservation.release() }
    throw error
  }
}

module.exports = { DISPLAY_MIN, DISPLAY_COUNT, displayPaths, requestDisplay, reserveDisplay, releaseSlot, reservationIdentity, withSlotLock, startOwnedDisplay, stopOwnedDisplay }
