#!/usr/bin/env node
'use strict'

// Prepare a native provider tree for an explicit Linux guest import.  This is
// deliberately a closure packer, not an installer: the caller supplies an
// already installed, pinned native tree and receives a fresh private copy plus
// a relocation witness.  The witness runs with the original tree absent from
// its mount namespace, so a rewritten shebang or an absolute source reference
// cannot masquerade as a transferable OMP import.
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCHEMA_VERSION = 1
const KIND = 'autoprompt-provider-closure-v1'
const MANIFEST = '.autoprompt-provider-closure.json'
const OMP = Object.freeze({
  provider: 'omp',
  command: 'omp',
  entrypoint: 'node_modules/.bin/omp',
  bun: 'node_modules/.bin/bun',
})

class ClosureError extends Error {
  constructor(code, message) { super(message); this.name = 'ClosureError'; this.code = code }
}
function fail(code, message) { throw new ClosureError(code, message) }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function fileSha256(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
  let descriptor
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!length) break
      hash.update(buffer.subarray(0, length))
    }
    return hash.digest('hex')
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}
function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PROVIDER_CLOSURE_INVALID', 'Closure output reservation changed')
  return { dev: stat.dev, ino: stat.ino }
}
function removeOwnedDirectory(directory, identity) {
  try {
    const current = directoryIdentity(directory)
    if (current.dev === identity.dev && current.ino === identity.ino) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 })
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
function removeOwnedFile(file, identity) {
  try {
    const current = fs.lstatSync(file, { bigint: true })
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
      fs.rmSync(file, { force: true, maxRetries: 2 })
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value ||
      /[\0-\x1f\x7f]/.test(value)) fail('PROVIDER_CLOSURE_PATH_INVALID', `${label} must be a physical absolute path`)
  return value
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function hiddenFromSystemBinds(root, label) {
  for (const systemRoot of ['/usr', '/lib', '/lib64']) {
    if (fs.existsSync(systemRoot) && inside(systemRoot, root)) {
      fail('PROVIDER_CLOSURE_PATH_INVALID', `${label} must not be below ${systemRoot}; the relocation witness binds system libraries there`)
    }
  }
}
function physicalDirectory(root, label) {
  absolute(root, label)
  let stat
  try { stat = fs.lstatSync(root, { bigint: true }) } catch { fail('PROVIDER_CLOSURE_PATH_INVALID', `${label} does not exist`) }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    fail('PROVIDER_CLOSURE_PATH_INVALID', `${label} must be a physical directory`)
  }
  return root
}
function regularExecutable(file, root, label) {
  let item
  try { item = fs.statSync(file, { bigint: true }) } catch { fail('PROVIDER_CLOSURE_INVALID', `${label} is missing`) }
  const real = fs.realpathSync.native(file)
  if (!item.isFile() || !inside(root, real) || (item.mode & 0o111n) === 0n) {
    fail('PROVIDER_CLOSURE_INVALID', `${label} is not an executable inside the closure`)
  }
  return real
}
function physicalExecutable(file, label) {
  absolute(file, label)
  let stat
  try { stat = fs.lstatSync(file, { bigint: true }) } catch { fail('PROVIDER_CLOSURE_PATH_INVALID', `${label} does not exist`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1n || (stat.mode & 0o111n) === 0n ||
      fs.realpathSync.native(file) !== file) {
    fail('PROVIDER_CLOSURE_PATH_INVALID', `${label} must be a physical executable file`)
  }
  return file
}
function safeCopiedDestination(root, file) {
  if (!inside(root, file) || file === root) fail('PROVIDER_CLOSURE_INVALID', 'Baseline Bun destination escapes the reserved closure')
  const parts = path.relative(root, file).split(path.sep)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const stat = fs.lstatSync(current)
    const last = index === parts.length - 1
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) {
      fail('PROVIDER_CLOSURE_INVALID', 'Baseline Bun destination contains a linked or invalid path')
    }
  }
  if (fs.realpathSync.native(path.dirname(file)) !== path.dirname(file)) {
    fail('PROVIDER_CLOSURE_INVALID', 'Baseline Bun destination parent is not physical')
  }
}
function linuxElfMachine(file, label) {
  const bytes = Buffer.alloc(20)
  let descriptor
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length ||
        !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[5] !== 1) {
      fail('PROVIDER_CLOSURE_INVALID', `${label} is not a little-endian Linux ELF executable`)
    }
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
  const machine = bytes.readUInt16LE(18)
  if (machine === 62) return 'x86_64'
  if (machine === 183) return 'aarch64'
  fail('PROVIDER_CLOSURE_INVALID', `${label} has an unsupported ELF machine`)
}
function closureEntries(root, skipManifest = true) {
  const entries = []
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name)
      const relative = path.relative(root, file)
      if (skipManifest && relative === MANIFEST) continue
      const stat = fs.lstatSync(file, { bigint: true })
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file)
        let real
        try { real = fs.realpathSync.native(file) } catch { fail('PROVIDER_CLOSURE_INVALID', `Closure link is dangling: ${relative}`) }
        if (!inside(root, real)) fail('PROVIDER_CLOSURE_INVALID', `Closure link escapes its root: ${relative}`)
        entries.push({ path: relative, type: 'link', target })
      } else if (stat.isDirectory()) {
        if ((stat.mode & 0o022n) !== 0n) fail('PROVIDER_CLOSURE_INVALID', `Closure directory is writable by another user: ${relative}`)
        entries.push({ path: relative, type: 'directory', mode: Number(stat.mode & 0o777n) })
        visit(file)
      } else if (stat.isFile()) {
        if ((stat.mode & 0o022n) !== 0n) fail('PROVIDER_CLOSURE_INVALID', `Closure file is writable by another user: ${relative}`)
        entries.push({ path: relative, type: 'file', mode: Number(stat.mode & 0o777n), sha256: sha256(fs.readFileSync(file)) })
      } else {
        fail('PROVIDER_CLOSURE_INVALID', `Closure entry is not a regular file, directory, or link: ${relative}`)
      }
      if (entries.length > 100000) fail('PROVIDER_CLOSURE_INVALID', 'Closure entry limit exceeded')
    }
  }
  visit(root)
  return entries
}
function portableDigest(root) { return sha256(Buffer.from(JSON.stringify(closureEntries(root)), 'utf8')) }
function hardenCopiedClosure(root) {
  const visit = current => {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        fs.chmodSync(file, stat.mode & ~0o022)
        visit(file)
      } else if (stat.isFile()) {
        fs.chmodSync(file, stat.mode & ~0o022)
      } else {
        fail('PROVIDER_CLOSURE_INVALID', `Closure entry is not portable: ${path.relative(root, file)}`)
      }
    }
  }
  fs.chmodSync(root, 0o700)
  visit(root)
}
function exactLink(root, relative, expectedTarget, label) {
  const file = path.join(root, relative)
  let stat, target
  try { stat = fs.lstatSync(file); target = fs.readlinkSync(file) } catch { fail('PROVIDER_CLOSURE_INVALID', `${label} is missing`) }
  if (!stat.isSymbolicLink() || target !== expectedTarget || !inside(root, fs.realpathSync.native(file))) {
    fail('PROVIDER_CLOSURE_INVALID', `${label} is not the expected internal npm link`)
  }
  return fs.realpathSync.native(file)
}
function readCommand(executable, argv, env, label, spawnSync = childProcess.spawnSync) {
  const result = spawnSync(executable, argv, { env, shell: false, encoding: 'utf8', timeout: 30_000 })
  const text = String(result?.stdout || result?.stderr || '').trim()
  if (result?.error || result?.status !== 0 || !text || /[\0]/.test(text) || text.length > 1024) {
    fail('PROVIDER_CLOSURE_PROBE_FAILED', `${label} cannot execute from its closure`)
  }
  return text
}
function readVersion(executable, env, label, spawnSync = childProcess.spawnSync) {
  return readCommand(executable, ['--version'], env, label, spawnSync)
}
function ompRuntime(root, arch, spawnSync = childProcess.spawnSync, options = {}) {
  physicalDirectory(root, 'Closure root')
  if (!['x86_64', 'aarch64'].includes(arch)) fail('PROVIDER_CLOSURE_ARCH_INVALID', 'OMP closure requires x86_64 or aarch64')
  const omp = exactLink(root, OMP.entrypoint, '../@oh-my-pi/pi-coding-agent/dist/cli.js', 'OMP entrypoint')
  const bundledBun = exactLink(root, OMP.bun, '../bun/bin/bun.exe', 'OMP Bun entrypoint')
  const bun = options.bun || bundledBun
  if (options.bun) physicalExecutable(bun, 'Baseline Bun runtime')
  const detectedArch = linuxElfMachine(bun, 'OMP Bun runtime')
  if (detectedArch !== arch) fail('PROVIDER_CLOSURE_ARCH_INVALID', `OMP Bun is ${detectedArch}, not requested ${arch}`)
  const ompHeader = fs.readFileSync(omp, 'utf8').split(/\r?\n/u, 1)[0]
  if (ompHeader !== '#!/usr/bin/env bun') fail('PROVIDER_CLOSURE_INVALID', 'OMP entrypoint must retain the reviewed Bun shebang')
  const environment = { PATH: `${path.join(root, 'node_modules', '.bin')}:/usr/bin:/bin`, HOME: '/nonexistent', LANG: 'C.UTF-8' }
  const bunVersion = readVersion(bun, environment, 'OMP Bun runtime', spawnSync)
  // Invoke the JavaScript entrypoint through this exact Bun binary for the
  // import-time probe. The later Bubblewrap witness deliberately invokes the
  // npm link so it separately proves that the reviewed `/usr/bin/env bun`
  // shebang resolves to the copied baseline runtime.
  const ompVersion = readCommand(bun, [omp, '--version'], environment, 'OMP entrypoint', spawnSync)
  return Object.freeze({ arch, bun, bunSha256: sha256(fs.readFileSync(bun)), bunVersion, omp, ompSha256: sha256(fs.readFileSync(omp)), ompVersion, environment })
}
function namespaceArguments(root, command, environment) {
  const parents = []
  for (let cursor = path.dirname(root); cursor !== '/'; cursor = path.dirname(cursor)) parents.push(cursor)
  const args = ['--unshare-user', '--uid', '0', '--gid', '0', '--die-with-parent']
  for (const systemRoot of ['/usr', '/lib', '/lib64']) {
    if (fs.existsSync(systemRoot)) args.push('--ro-bind', systemRoot, systemRoot)
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  for (const parent of parents.reverse()) args.push('--dir', parent)
  args.push('--ro-bind', root, root, '--chdir', root, '--clearenv', '--setenv', 'PATH', environment.PATH,
    '--setenv', 'HOME', environment.HOME, '--setenv', 'LANG', environment.LANG, command, '--version')
  return args
}
function relocationSmoke(root, runtime, spawnSync = childProcess.spawnSync) {
  const bwrap = '/usr/bin/bwrap'
  try { fs.accessSync(bwrap, fs.constants.X_OK) } catch { fail('PROVIDER_CLOSURE_PROBE_FAILED', 'Linux bubblewrap is required for a source-hidden relocation witness') }
  const result = spawnSync(bwrap, namespaceArguments(root, path.join(root, OMP.entrypoint), runtime.environment), {
    shell: false, encoding: 'utf8', timeout: 30_000,
  })
  const text = String(result?.stdout || result?.stderr || '').trim()
  if (result?.error || result?.status !== 0 || text !== runtime.ompVersion) {
    fail('PROVIDER_CLOSURE_PROBE_FAILED', 'OMP closure did not run when the original source tree was absent from its mount namespace')
  }
  return { mechanism: 'bubblewrap-source-hidden-v1', ompVersion: text }
}
function readManifest(root) {
  const file = path.join(root, MANIFEST)
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('PROVIDER_CLOSURE_INVALID', 'Provider closure manifest is unreadable') }
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.kind !== KIND || value.provider !== 'omp' ||
      !['x86_64', 'aarch64'].includes(value.arch) || typeof value.portableSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.portableSha256) || typeof value.entrypoint !== 'object') {
    fail('PROVIDER_CLOSURE_INVALID', 'Provider closure manifest has an invalid shape')
  }
  return value
}
function verifyOmpClosure(options = {}) {
  const root = physicalDirectory(options.root, 'Closure root')
  const manifest = readManifest(root)
  const runtime = ompRuntime(root, manifest.arch, options.spawnSync)
  if (portableDigest(root) !== manifest.portableSha256 || runtime.ompSha256 !== manifest.entrypoint.ompSha256 ||
      runtime.bunSha256 !== manifest.entrypoint.bunSha256 || runtime.ompVersion !== manifest.entrypoint.ompVersion ||
      runtime.bunVersion !== manifest.entrypoint.bunVersion) {
    fail('PROVIDER_CLOSURE_INVALID', 'Provider closure content differs from its manifest')
  }
  const relocation = options.relocation === false ? null : relocationSmoke(root, runtime, options.spawnSync)
  return Object.freeze({ root, manifest, runtime, relocation })
}
function prepareOmpClosure(options = {}) {
  if (process.platform !== 'linux') fail('PROVIDER_CLOSURE_PLATFORM_INVALID', 'OMP guest closures must be prepared on Linux')
  const source = physicalDirectory(options.source, 'OMP source')
  const output = absolute(options.output, 'Closure output')
  hiddenFromSystemBinds(source, 'OMP source')
  hiddenFromSystemBinds(output, 'Closure output')
  if (fs.existsSync(output) || inside(source, output) || inside(output, source)) fail('PROVIDER_CLOSURE_PATH_INVALID', 'Closure output must be a new directory disjoint from the source')
  const parent = path.dirname(output)
  physicalDirectory(parent, 'Closure output parent')
  const requestedArchive = options.archive ? absolute(options.archive, 'Closure archive') : null
  if (requestedArchive && (fs.existsSync(requestedArchive) || inside(output, requestedArchive))) {
    fail('PROVIDER_CLOSURE_PATH_INVALID', 'Closure archive must be a new file outside the closure')
  }
  const baselineBun = physicalExecutable(options.bun, 'Baseline Bun runtime')
  if (linuxElfMachine(baselineBun, 'Baseline Bun runtime') !== options.arch) {
    fail('PROVIDER_CLOSURE_ARCH_INVALID', 'Baseline Bun architecture does not match the requested guest architecture')
  }
  const sourceRuntime = ompRuntime(source, options.arch, options.spawnSync, { bun: baselineBun })
  let outputIdentity = null
  let archiveOwned = false
  let archiveIdentity = null
  try {
    // Reserve the public output path first.  Copying into that exact owned
    // directory prevents a concurrent empty-directory rename from replacing
    // somebody else's output, and lets failure cleanup compare its inode.
    fs.mkdirSync(output, { mode: 0o700 })
    outputIdentity = directoryIdentity(output)
    fs.cpSync(source, output, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true })
    // Native installations commonly retain an installer log with its caller's
    // permissive mode.  The copied import owns its bytes, so remove only
    // group/other write bits while preserving executability and link targets.
    hardenCopiedClosure(output)
    const copiedBun = path.join(output, 'node_modules', 'bun', 'bin', 'bun.exe')
    safeCopiedDestination(output, copiedBun)
    fs.copyFileSync(baselineBun, copiedBun)
    fs.chmodSync(copiedBun, fs.statSync(baselineBun).mode & 0o777)
    const copiedRuntime = ompRuntime(output, options.arch, options.spawnSync)
    if (copiedRuntime.ompSha256 !== sourceRuntime.ompSha256 || copiedRuntime.bunSha256 !== sourceRuntime.bunSha256 ||
        copiedRuntime.ompVersion !== sourceRuntime.ompVersion || copiedRuntime.bunVersion !== sourceRuntime.bunVersion) {
      fail('PROVIDER_CLOSURE_INVALID', 'Copied OMP closure runtime differs from its source')
    }
    const manifest = {
      schemaVersion: SCHEMA_VERSION, kind: KIND, provider: 'omp', platform: 'linux', arch: options.arch,
      entrypoint: { command: OMP.command, relativePath: OMP.entrypoint, ompSha256: copiedRuntime.ompSha256,
        ompVersion: copiedRuntime.ompVersion, bunRelativePath: OMP.bun, bunSha256: copiedRuntime.bunSha256,
        bunVersion: copiedRuntime.bunVersion },
      portableSha256: portableDigest(output),
    }
    fs.writeFileSync(path.join(output, MANIFEST), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 })
    const relocation = relocationSmoke(output, copiedRuntime, options.spawnSync)
    let archive = null
    if (requestedArchive) {
      const descriptor = fs.openSync(requestedArchive, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      archiveIdentity = fs.fstatSync(descriptor, { bigint: true })
      fs.closeSync(descriptor)
      archiveOwned = true
      const result = (options.spawnSync || childProcess.spawnSync)('/usr/bin/tar', ['--create', '--format=posix', '--file', requestedArchive,
        '--owner=0', '--group=0', '--numeric-owner', '-C', path.dirname(output), path.basename(output)], { shell: false, encoding: 'utf8', timeout: 30 * 60 * 1000 })
      if (result?.error || result?.status !== 0) fail('PROVIDER_CLOSURE_ARCHIVE_FAILED', 'Cannot write the OMP closure tar archive')
      archive = Object.freeze({ path: requestedArchive, sha256: fileSha256(requestedArchive) })
    }
    return Object.freeze({ root: output, manifest, relocation, ...(archive ? { archive } : {}) })
  } catch (error) {
    if (outputIdentity) removeOwnedDirectory(output, outputIdentity)
    if (archiveOwned && requestedArchive && archiveIdentity) removeOwnedFile(requestedArchive, archiveIdentity)
    throw error
  }
}
function run(argv = process.argv.slice(2), io = process) {
  const [action, provider, ...rest] = argv
  if (action !== 'prepare' || provider !== 'omp') fail('PROVIDER_CLOSURE_USAGE', 'Usage: provider-closure prepare omp --source <installed-root> --bun <baseline-bun> --output <new-root> --arch <x86_64|aarch64> [--archive <new-tar>]')
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1]
    if (!['--source', '--bun', '--output', '--arch', '--archive'].includes(flag) || value === undefined || values[flag]) fail('PROVIDER_CLOSURE_USAGE', 'Provider closure flags must be explicit and unique')
    values[flag] = value
  }
  for (const flag of ['--source', '--bun', '--output', '--arch']) if (!values[flag]) fail('PROVIDER_CLOSURE_USAGE', `Provider closure requires ${flag}`)
  const result = prepareOmpClosure({ source: values['--source'], bun: values['--bun'], output: values['--output'], arch: values['--arch'], ...(values['--archive'] ? { archive: values['--archive'] } : {}) })
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
if (require.main === module) {
  try { process.exitCode = run() } catch (error) { process.stderr.write(`Autoprompt provider closure: ${error.code || 'PROVIDER_CLOSURE_FAILED'}: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { ClosureError, MANIFEST, portableDigest, ompRuntime, relocationSmoke, verifyOmpClosure, prepareOmpClosure, run }
