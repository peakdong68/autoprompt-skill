#!/usr/bin/env node
'use strict'

// Build a Linux-native Hermes import that does not retain the editable venv's
// interpreter, .pth finder, or source checkout.  The resulting directory is
// the `native` argument accepted by the Lima backend (and the root archived
// for WSL).  It intentionally packages no provider connection or Hermes home.
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SCHEMA_VERSION = 1
const KIND = 'autoprompt-hermes-linux-closure-v1'
const MANIFEST = '.autoprompt-hermes-linux-closure.json'
const SENSITIVE_NAMES = new Set(['.env', '.netrc', 'auth.json', 'credentials.json', 'id_rsa', 'id_ed25519'])

class HermesClosureError extends Error {
  constructor(code, message) { super(message); this.name = 'HermesClosureError'; this.code = code }
}
function fail(code, message) { throw new HermesClosureError(code, message) }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex') }
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\0-\x1f\x7f]/.test(value)) fail('HERMES_CLOSURE_PATH_INVALID', `${label} must be a physical absolute path`)
  return value
}
function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
function physicalDirectory(value, label) {
  const directory = absolute(value, label)
  let stat
  try { stat = fs.lstatSync(directory) } catch { fail('HERMES_CLOSURE_PATH_INVALID', `${label} does not exist`) }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) fail('HERMES_CLOSURE_PATH_INVALID', `${label} must be a physical directory`)
  return directory
}
function physicalFile(value, label) {
  const file = absolute(value, label)
  let stat
  try { stat = fs.lstatSync(file) } catch { fail('HERMES_CLOSURE_PATH_INVALID', `${label} does not exist`) }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(file) !== file) fail('HERMES_CLOSURE_PATH_INVALID', `${label} must be a physical file`)
  return file
}
function ownedDirectory(value) {
  const stat = fs.lstatSync(value, { bigint: true })
  return { dev: stat.dev, ino: stat.ino }
}
function removeOwnedDirectory(value, expected) {
  try {
    const stat = fs.lstatSync(value, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) return
    fs.rmSync(value, { recursive: true, force: true, maxRetries: 2 })
  } catch {}
}
function machine(file) {
  const bytes = Buffer.alloc(20); let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[5] !== 1) fail('HERMES_CLOSURE_INVALID', 'Python interpreter is not a little-endian Linux ELF executable')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
  const value = bytes.readUInt16LE(18)
  if (value === 62) return 'x86_64'
  if (value === 183) return 'aarch64'
  fail('HERMES_CLOSURE_INVALID', 'Python interpreter has an unsupported ELF machine')
}
function secretName(relative) {
  const base = path.basename(relative).toLowerCase()
  return SENSITIVE_NAMES.has(base) || /^(?:credentials?|auth|tokens?|secrets?)[._-]?(?:local|private|prod|production)?\.(?:json|ya?ml|toml|ini)$/u.test(base) ||
    /^(?:id_rsa|id_ed25519|private[_-]?key|secret[_-]?key)\b/u.test(base) || /\.(?:p12|pfx)$/u.test(base)
}
function skipSite(relative) {
  const base = path.basename(relative)
  return base.endsWith('.pyc') || base.endsWith('.pyo') || base === '__pycache__' || base.endsWith('.pth') || base.startsWith('__editable__') || base === 'direct_url.json'
}
function copyTree(source, destination, options = {}) {
  const { filter = () => true, credentials = false, permitExternalFileLinks = false } = options
  const visit = (current, target, relative) => {
    if (!filter(relative)) return
    const stat = fs.lstatSync(current)
    if (credentials && secretName(relative)) fail('HERMES_CLOSURE_CREDENTIAL_REFUSED', `Refusing to package a possible credential: ${relative}`)
    if (stat.isDirectory()) {
      if (fs.existsSync(target)) {
        const existing = fs.lstatSync(target)
        if (!existing.isDirectory() || existing.isSymbolicLink()) fail('HERMES_CLOSURE_INVALID', `Closure copy destination is not a physical directory: ${relative}`)
      } else fs.mkdirSync(target, { mode: stat.mode & 0o755 })
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(target, name), relative ? path.join(relative, name) : name)
      fs.chmodSync(target, stat.mode & ~0o022)
      return
    }
    if (stat.isSymbolicLink()) {
      // A closure may not retain a path reference.  A file link is copied as
      // bytes only after proving it resolves within its declared input tree;
      // directory links are rejected rather than accidentally importing an
      // arbitrary host tree.
      const resolved = fs.realpathSync.native(current)
      const targetStat = fs.statSync(resolved)
      if (targetStat.isDirectory() || (!permitExternalFileLinks && !within(source, resolved))) fail('HERMES_CLOSURE_LINK_ESCAPE', `Input symlink escapes its declared tree: ${relative}`)
      fs.copyFileSync(resolved, target); fs.chmodSync(target, targetStat.mode & ~0o022); return
    }
    if (!stat.isFile()) fail('HERMES_CLOSURE_INVALID', `Input has an unsupported entry: ${relative}`)
    fs.copyFileSync(current, target); fs.chmodSync(target, stat.mode & ~0o022)
  }
  visit(source, destination, '')
}
function entries(root, omitManifest = true) {
  const result = []
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), relative = path.relative(root, file)
      if (omitManifest && relative === MANIFEST) continue
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) fail('HERMES_CLOSURE_LINK_ESCAPE', `Closure retains a symlink: ${relative}`)
      if (stat.isDirectory()) { result.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 }); visit(file) }
      else if (stat.isFile()) result.push({ path: relative, type: 'file', mode: stat.mode & 0o777, sha256: sha256(fs.readFileSync(file)) })
      else fail('HERMES_CLOSURE_INVALID', `Closure has an unsupported entry: ${relative}`)
      if (result.length > 200000) fail('HERMES_CLOSURE_INVALID', 'Closure entry limit exceeded')
    }
  }
  visit(root); return result
}
function portableDigest(root) { return sha256(JSON.stringify(entries(root))) }
function pythonMetadata(python, venv) {
  const script = 'import json,platform,sys,sysconfig;print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"stdlib":sysconfig.get_path("stdlib"),"purelib":sysconfig.get_path("purelib"),"soabi":sysconfig.get_config_var("SOABI"),"multiarch":sysconfig.get_config_var("MULTIARCH"),"machine":platform.machine()}))'
  const executable = path.join(venv, 'bin', 'python')
  try { fs.accessSync(executable, fs.constants.X_OK) } catch { fail('HERMES_CLOSURE_INVALID', 'Hermes venv has no executable bin/python') }
  const result = childProcess.spawnSync(executable, ['-c', script], { shell: false, encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1' } })
  if (result.error || result.status !== 0) fail('HERMES_CLOSURE_PROBE_FAILED', 'Hermes venv Python metadata cannot be read')
  let metadata
  try { metadata = JSON.parse(result.stdout) } catch { fail('HERMES_CLOSURE_PROBE_FAILED', 'Hermes venv Python metadata is invalid') }
  for (const key of ['version', 'stdlib', 'purelib', 'soabi', 'multiarch', 'machine']) if (typeof metadata[key] !== 'string' || !metadata[key]) fail('HERMES_CLOSURE_PROBE_FAILED', `Hermes Python metadata lacks ${key}`)
  if (machine(python) !== (metadata.machine === 'x86_64' ? 'x86_64' : metadata.machine === 'aarch64' ? 'aarch64' : 'unsupported')) fail('HERMES_CLOSURE_ARCH_INVALID', 'Hermes Python metadata does not match its ELF interpreter')
  return metadata
}
function ldd(file) {
  const result = childProcess.spawnSync('/usr/bin/ldd', [file], { shell: false, encoding: 'utf8', timeout: 30000 })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.error || result.status !== 0 || /not found/i.test(output)) fail('HERMES_CLOSURE_ABI_INVALID', `Dynamic dependencies are unresolved for ${path.basename(file)}`)
  return output.split(/\r?\n/u).map(line => {
    const match = /=>\s+(\/[^\s]+)|^\s*(\/[^\s]+)\s+\(/u.exec(line)
    return match?.[1] || match?.[2] || null
  }).filter(Boolean)
}
function privatePythonLibraries(python, destination) {
  const libraries = ldd(python).filter(file => path.basename(file).startsWith('libpython'))
  for (const library of libraries) {
    const source = physicalFile(fs.realpathSync.native(library), 'Python dynamic library')
    fs.copyFileSync(source, path.join(destination, path.basename(source)))
    fs.chmodSync(path.join(destination, path.basename(source)), 0o600)
  }
  return libraries.map(file => path.basename(fs.realpathSync.native(file)))
}
function launcher(root, metadata) {
  const python = path.join(root, 'python', 'bin', `python${metadata.version.split('.').slice(0, 2).join('.')}`)
  const wrapper = path.join(root, 'bin', 'python')
  const hermes = path.join(root, 'bin', 'hermes')
  const script = (target, suffix) => `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd -P)\nexport PYTHONHOME=\"$root/python\"\nexport LD_LIBRARY_PATH=\"$root/python/lib\"\nexport PYTHONDONTWRITEBYTECODE=1\nunset PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE VIRTUAL_ENV\nexport PYTHONPATH=\"$root/python/local/lib/python${metadata.version.split('.').slice(0, 2).join('.')}/dist-packages:$root/source\"\nexec \"${target}\" ${suffix} \"$@\"\n`
  fs.mkdirSync(path.dirname(wrapper), { recursive: true, mode: 0o700 })
  fs.writeFileSync(wrapper, script('$root/python/bin/' + path.basename(python), ''), { mode: 0o700 })
  fs.writeFileSync(hermes, script('$root/python/bin/' + path.basename(python), '-s -m hermes_cli.main'), { mode: 0o700 })
  return { python: path.relative(root, wrapper), hermes: path.relative(root, hermes), runtimePython: path.relative(root, python) }
}
function rejectHostReferences(root, forbidden) {
  for (const entry of entries(root)) {
    if (entry.type !== 'file' || entry.path === MANIFEST) continue
    const file = path.join(root, entry.path), bytes = fs.readFileSync(file)
    if (bytes.includes(Buffer.from(forbidden))) fail('HERMES_CLOSURE_HOST_REFERENCE', `Closure still contains its source install path: ${entry.path}`)
  }
}
function repairRecords(root) {
  const firstCsvField = line => {
    if (!line.startsWith('"')) return line.slice(0, line.indexOf(','))
    let value = ''
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] !== '"') { value += line[index]; continue }
      if (line[index + 1] === '"') { value += '"'; index += 1; continue }
      return line[index + 1] === ',' ? value : null
    }
    return null
  }
  const records = []
  const visit = current => {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name), stat = fs.lstatSync(file)
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile() && name === 'RECORD') records.push(file)
    }
  }
  visit(root)
  for (const record of records) {
    const kept = fs.readFileSync(record, 'utf8').split(/\r?\n/u).filter(line => {
      if (!line) return false
      const relative = firstCsvField(line)
      if (!relative || path.isAbsolute(relative)) return false
      const candidate = path.resolve(root, relative)
      try {
        if (within(root, candidate) && fs.lstatSync(candidate).isFile()) return true
        // These entries name the deliberately omitted editable metadata or a
        // virtualenv console script outside the copied site-package tree.
        if (skipSite(relative) || !within(root, candidate)) return false
      } catch { if (skipSite(relative) || !within(root, candidate)) return false }
      fail('HERMES_CLOSURE_INVALID', `Package RECORD names an unavailable dependency: ${relative}`)
    })
    fs.writeFileSync(record, `${kept.join('\n')}\n`, { mode: 0o600 })
  }
}
function runtime(root) {
  const manifestFile = path.join(root, MANIFEST)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { fail('HERMES_CLOSURE_INVALID', 'Hermes closure manifest is unreadable') }
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== KIND || manifest.provider !== 'hermes' || manifest.platform !== 'linux' ||
      !['x86_64', 'aarch64'].includes(manifest.arch) || typeof manifest.portableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.portableSha256) ||
      !manifest.entrypoint || typeof manifest.entrypoint.python !== 'string' || typeof manifest.entrypoint.hermes !== 'string' || typeof manifest.entrypoint.runtimePython !== 'string') {
    fail('HERMES_CLOSURE_INVALID', 'Hermes closure manifest has an invalid shape')
  }
  for (const value of Object.values(manifest.entrypoint)) if (typeof value !== 'string' || value.includes('..') || path.isAbsolute(value)) fail('HERMES_CLOSURE_INVALID', 'Hermes closure manifest has an unsafe entrypoint')
  const result = Object.fromEntries(Object.entries(manifest.entrypoint).map(([key, value]) => [key, path.join(root, value)]))
  for (const [key, file] of Object.entries(result)) {
    let stat
    try { stat = fs.lstatSync(file) } catch { fail('HERMES_CLOSURE_INVALID', `Hermes closure ${key} entrypoint is missing`) }
    if (!stat.isFile() || stat.isSymbolicLink() || !within(root, fs.realpathSync.native(file))) fail('HERMES_CLOSURE_LINK_ESCAPE', `Hermes closure ${key} entrypoint escapes its root`)
  }
  if (portableDigest(root) !== manifest.portableSha256) fail('HERMES_CLOSURE_INVALID', 'Hermes closure content differs from its manifest')
  return Object.freeze({ root, manifest: Object.freeze(manifest), ...result })
}
function namespaceArgs(root, executable, hidden = []) {
  const parents = []
  for (let cursor = path.dirname(root); cursor !== '/'; cursor = path.dirname(cursor)) parents.push(cursor)
  const args = ['--unshare-user', '--uid', '0', '--gid', '0', '--die-with-parent', '--clearenv']
  for (const system of ['/usr', '/bin', '/lib', '/lib64']) if (fs.existsSync(system)) args.push('--ro-bind', system, system)
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  for (const parent of parents.reverse()) args.push('--dir', parent)
  for (const hiddenRoot of hidden) {
    if (!path.isAbsolute(hiddenRoot) || hiddenRoot === '/' || hiddenRoot === root) continue
    const parent = path.dirname(hiddenRoot)
    // /tmp is already a private tmpfs in the witness.  Other parents may be
    // visible through a read-only system bind, where the destination exists.
    if (parent.startsWith('/tmp/')) {
      const chain = []; for (let cursor = parent; cursor !== '/tmp'; cursor = path.dirname(cursor)) chain.push(cursor)
      for (const directory of chain.reverse()) args.push('--dir', directory)
    }
    args.push('--tmpfs', hiddenRoot)
  }
  args.push('--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/nonexistent', '--setenv', 'PYTHONNOUSERSITE', '1')
  args.push('--ro-bind', root, root, executable, '--version')
  return args
}
function relocationSmoke(root, closure = runtime(root), spawnSync = childProcess.spawnSync, hidden = []) {
  try { fs.accessSync('/usr/bin/bwrap', fs.constants.X_OK) } catch { fail('HERMES_CLOSURE_PROBE_FAILED', 'Linux bubblewrap is required for the source-hidden relocation witness') }
  const audit = String.raw`import json,sqlite3,sys,sysconfig,hermes_cli
root=sys.argv[1]
paths=[sys.executable,sys.prefix,sysconfig.get_path("stdlib"),hermes_cli.__file__]
assert all(isinstance(item,str) and item.startswith(root + "/") for item in paths), paths
print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"stdlib":sysconfig.get_path("stdlib"),"hermes":hermes_cli.__file__},sort_keys=True))`
  const directAudit = spawnSync(closure.python, ['-s', '-c', audit, root], { shell: false, encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', PYTHONNOUSERSITE: '1' } })
  if (directAudit.error || directAudit.status !== 0) fail('HERMES_CLOSURE_PROBE_FAILED', 'Hermes Python cannot initialize its private stdlib and source')
  const direct = spawnSync(closure.hermes, ['--version'], { shell: false, encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', PYTHONNOUSERSITE: '1' } })
  const version = String(direct.stdout || direct.stderr || '').trim()
  if (direct.error || direct.status !== 0 || !version) fail('HERMES_CLOSURE_PROBE_FAILED', 'Hermes cannot execute from its copied closure')
  const relocatedAudit = spawnSync('/usr/bin/bwrap', [...namespaceArgs(root, closure.python, hidden).slice(0, -2), closure.python, '-s', '-c', audit, root], { shell: false, encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })
  if (relocatedAudit.error || relocatedAudit.status !== 0 || relocatedAudit.stdout !== directAudit.stdout) fail('HERMES_CLOSURE_PROBE_FAILED', 'Hermes Python initialization changed in the source-hidden relocation witness')
  const relocated = spawnSync('/usr/bin/bwrap', namespaceArgs(root, closure.hermes, hidden), { shell: false, encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })
  const observed = String(relocated.stdout || relocated.stderr || '').trim()
  if (relocated.error || relocated.status !== 0 || observed !== version) fail('HERMES_CLOSURE_PROBE_FAILED', 'Hermes did not run when its original venv and source checkout were absent')
  return Object.freeze({ mechanism: 'bubblewrap-source-hidden-v1', version, python: JSON.parse(directAudit.stdout) })
}
function prepare(options = {}) {
  if (process.platform !== 'linux') fail('HERMES_CLOSURE_PLATFORM_INVALID', 'Hermes Linux closures must be prepared on Linux')
  const venv = physicalDirectory(options.venv, 'Hermes venv'), source = physicalDirectory(options.source, 'Hermes source'), output = absolute(options.output, 'Closure output')
  if (fs.existsSync(output) || within(venv, output) || within(output, venv) || within(source, output) || within(output, source)) fail('HERMES_CLOSURE_PATH_INVALID', 'Closure output must be a new directory disjoint from the venv and source')
  physicalDirectory(path.dirname(output), 'Closure output parent')
  const python = physicalFile(fs.realpathSync.native(options.python || path.join(venv, 'bin', 'python')), 'Python interpreter')
  const metadata = pythonMetadata(python, venv)
  if (options.arch && options.arch !== machine(python)) fail('HERMES_CLOSURE_ARCH_INVALID', 'Requested architecture does not match Python interpreter')
  const arch = machine(python)
  const stdlib = physicalDirectory(metadata.stdlib, 'Python standard library'), site = physicalDirectory(metadata.purelib, 'Hermes site packages')
  fs.mkdirSync(output, { mode: 0o700 })
  const outputIdentity = ownedDirectory(output)
  try {
    // Debian's sysconfig records this platform package directory under
    // `local/lib`; the private wrapper adds this exact directory to Python's
    // path after clearing the caller's PYTHONPATH.
    const pythonRoot = path.join(output, 'python'), stdlibOut = path.join(pythonRoot, 'lib', path.basename(stdlib)), siteOut = path.join(pythonRoot, 'local', 'lib', path.basename(stdlib), 'dist-packages')
    fs.mkdirSync(path.join(pythonRoot, 'bin'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(stdlibOut), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(siteOut), { recursive: true, mode: 0o700 })
    fs.copyFileSync(python, path.join(pythonRoot, 'bin', `python${metadata.version.split('.').slice(0, 2).join('.')}`)); fs.chmodSync(path.join(pythonRoot, 'bin', `python${metadata.version.split('.').slice(0, 2).join('.')}`), 0o700)
    const libraries = privatePythonLibraries(python, path.join(pythonRoot, 'lib'))
    // Debian's stdlib links libpython and sitecustomize from ABI-owned system
    // paths.  Materialize those file bytes; the output keeps no symlinks.
    copyTree(stdlib, stdlibOut, { permitExternalFileLinks: true })
    copyTree(site, siteOut, { filter: relative => !skipSite(relative), credentials: true })
    // Editable finder/.pth/direct-url files are deliberately omitted. Keep
    // package metadata truthful so importlib.metadata cannot report a file
    // that the closure no longer contains.
    repairRecords(siteOut)
    copyTree(source, path.join(output, 'source'), { filter: relative => !['.git', '__pycache__'].includes(path.basename(relative)) && !path.basename(relative).startsWith('.env'), credentials: true })
    fs.writeFileSync(path.join(siteOut, 'autoprompt-hermes-source.pth'), '../../../../../source\n', { mode: 0o600 })
    const entrypoint = launcher(output, metadata)
    rejectHostReferences(output, venv); rejectHostReferences(output, source)
    const manifest = { schemaVersion: SCHEMA_VERSION, kind: KIND, provider: 'hermes', platform: 'linux', arch,
      python: { version: metadata.version, soabi: metadata.soabi, multiarch: metadata.multiarch, privateLibraries: libraries }, entrypoint,
      sourceSha256: sha256(JSON.stringify(entries(path.join(output, 'source'), false))), portableSha256: portableDigest(output) }
    fs.writeFileSync(path.join(output, MANIFEST), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 })
    const closure = runtime(output), relocation = relocationSmoke(output, closure, childProcess.spawnSync, [venv, source])
    let archive
    if (options.archive) {
      const archivePath = absolute(options.archive, 'Closure archive')
      if (fs.existsSync(archivePath) || within(output, archivePath)) fail('HERMES_CLOSURE_PATH_INVALID', 'Closure archive must be a new file outside the closure')
      const fd = fs.openSync(archivePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      const before = fs.fstatSync(fd, { bigint: true })
      try {
        // The inherited descriptor, rather than archivePath, is the tar
        // target.  A name replacement cannot make tar overwrite another file.
        const packed = childProcess.spawnSync('/usr/bin/tar', ['--create', '--format=posix', '--file', '/proc/self/fd/3', '--owner=0', '--group=0', '--numeric-owner', '-C', path.dirname(output), path.basename(output)], { shell: false, encoding: 'utf8', timeout: 30 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe', fd] })
        const named = fs.lstatSync(archivePath, { bigint: true }), after = fs.fstatSync(fd, { bigint: true })
        if (packed.error || packed.status !== 0 || !named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino) fail('HERMES_CLOSURE_ARCHIVE_FAILED', 'Hermes closure archive could not be written safely')
        archive = { path: archivePath, sha256: sha256(fs.readFileSync(archivePath)) }
      } catch (error) {
        try { const named = fs.lstatSync(archivePath, { bigint: true }); if (named.dev === before.dev && named.ino === before.ino) fs.unlinkSync(archivePath) } catch {}
        throw error
      } finally { fs.closeSync(fd) }
    }
    return Object.freeze({ root: output, manifest: closure.manifest, relocation, ...(archive ? { archive } : {}) })
  } catch (error) {
    removeOwnedDirectory(output, outputIdentity); throw error
  }
}
function run(argv = process.argv.slice(2), io = process) {
  const [action, ...flags] = argv
  if (!['prepare', 'verify'].includes(action)) fail('HERMES_CLOSURE_USAGE', 'Usage: hermes-runtime-closure <prepare|verify> --root <closure> [--venv <venv> --source <source> --python <python> --arch <x86_64|aarch64> --archive <new-tar>]')
  const values = {}
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index], value = flags[index + 1]
    if (!['--root', '--venv', '--source', '--python', '--arch', '--archive'].includes(flag) || value === undefined || values[flag]) fail('HERMES_CLOSURE_USAGE', 'Closure flags must be explicit and unique')
    values[flag] = value
  }
  if (!values['--root']) fail('HERMES_CLOSURE_USAGE', 'Closure requires --root')
  if (action === 'prepare' && (!values['--venv'] || !values['--source'])) fail('HERMES_CLOSURE_USAGE', 'Prepare requires --venv and --source')
  const result = action === 'prepare'
    ? prepare({ output: values['--root'], venv: values['--venv'], source: values['--source'], python: values['--python'], arch: values['--arch'], archive: values['--archive'] })
    : (() => { const closure = runtime(physicalDirectory(values['--root'], 'Closure root')); return { root: closure.root, manifest: closure.manifest, relocation: relocationSmoke(closure.root, closure) } })()
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0
}
if (require.main === module) {
  try { process.exitCode = run() } catch (error) { process.stderr.write(`Autoprompt Hermes closure: ${error.code || 'HERMES_CLOSURE_FAILED'}: ${error.message}\n`); process.exitCode = 1 }
}
module.exports = { HermesClosureError, MANIFEST, KIND, portableDigest, runtime, relocationSmoke, prepare, run }
