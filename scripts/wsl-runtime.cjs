#!/usr/bin/env node
'use strict'

// Dedicated WSL2 backend for Windows. The imported distribution owns the
// controller state; the Windows host exports only one explicitly bound target.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const lima = require('./lima-runtime.cjs')
const { parseRequest, GUEST_ROOT } = require('./lima-runtime-guest.cjs')

const GUEST_TARGET = '/home/autoprompt/target'
const HASH = /^[a-f0-9]{64}$/
const PUBLIC_PROVIDERS = new Set(Object.keys(lima.PROVIDER_CONNECTION_RULES))
const POWERSHELL_RELATIVE = path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const WSL_VHD_CAPABILITY_SID = 's-1-15-3-1024-2268835264-3721307629-241982045-173645152-1490879176-104643441-2915960892-1612460704'
const EXTRACTOR = `import os,shutil,sys,tarfile,tempfile
archive,destination,mode=sys.argv[1:]
parent=os.path.dirname(destination.rstrip('/'))
os.makedirs(parent,mode=0o700,exist_ok=True)
if os.path.lexists(destination): raise RuntimeError('destination already exists')
temporary=tempfile.mkdtemp(prefix='.autoprompt-import-',dir=parent)
try:
  with tarfile.open(archive,'r:*') as source:
    members=source.getmembers()
    if not members or len(members)>100000: raise RuntimeError('archive entry bound invalid')
    for member in members:
      normalized=os.path.normpath(member.name.replace('\\\\','/'))
      if normalized in ('','.','..') or normalized.startswith('../') or normalized.startswith('/') or member.isdev() or member.isfifo(): raise RuntimeError('unsafe archive entry')
    source.extractall(temporary,filter='data')
  if mode=='strip-one':
    names=os.listdir(temporary)
    if len(names)!=1 or not os.path.isdir(os.path.join(temporary,names[0])): raise RuntimeError('native archive must have one top-level directory')
    shutil.move(os.path.join(temporary,names[0]),destination)
  elif mode=='preserve':
    os.mkdir(destination,0o700)
    for name in os.listdir(temporary): shutil.move(os.path.join(temporary,name),os.path.join(destination,name))
  else: raise RuntimeError('unknown extraction mode')
finally:
  shutil.rmtree(temporary,ignore_errors=True)
`

function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function sha256File(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
  try { for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)) } }
  finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function windowsPath(value, label) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || path.win32.normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail('WSL_PATH_INVALID', `${label} must be a normalized absolute Windows path`)
  return value
}
function binding(file, directory = false, allowSystemHardlink = false) {
  const before = fs.lstatSync(file, { bigint: true })
  if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || (!allowSystemHardlink && before.nlink !== 1n)) || fs.realpathSync(file) !== file) fail('WSL_PATH_UNSAFE', `A WSL backend path is linked or not physical: ${file}`)
  const result = { path: file, dev: String(before.dev), ino: String(before.ino) }
  if (!directory) Object.assign(result, { size: String(before.size), mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs), nlink: String(before.nlink), sha256: sha256File(file), ...(allowSystemHardlink ? { systemExecutable: true } : {}) })
  return result
}
function assertBinding(expected, directory = false) {
  const actual = binding(expected.path, directory, expected.systemExecutable === true)
  if (Object.entries(actual).some(([key, value]) => expected[key] !== value)) fail('WSL_BINDING_CHANGED', 'A bound WSL backend input changed; create a new backend')
}
function assertSemanticBinding(expected, actual, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('WSL_BINDING_CHANGED', `${label} binding changed; create a new backend`)
}
function exactDigest(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('WSL_DIGEST_INVALID', `${label} requires an exact lowercase SHA-256 digest`)
  return value
}
function verifyDigest(record, expected, label) {
  if (record.sha256 !== exactDigest(expected, label)) fail('WSL_DIGEST_MISMATCH', `${label} does not match its required digest`)
}
function controlledEnv(root) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  // WSL registration is user scoped and silently no-ops on some builds when
  // Windows' standard profile, machine, or architecture variables are absent.
  // Keep an explicit non-secret OS allowlist while excluding module paths and
  // all provider credentials from the helper environment.
  const keep = ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles',
    'ALLUSERSPROFILE', 'COMPUTERNAME', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
    'DriverData', 'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PUBLIC', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemDrive',
    'USERDOMAIN', 'USERNAME']
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.win32.join(systemRoot, 'System32', 'cmd.exe'), PATH: path.win32.join(systemRoot, 'System32'), AUTOPROMPT_WSL_ROOT: root }
  for (const name of keep) if (process.env[name]) env[name] = process.env[name]
  return env
}
function validateWslStorageAcl(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.currentName || !snapshot.currentSid || !Array.isArray(snapshot.items) || snapshot.items.length !== 2 || !Array.isArray(snapshot.runningWslVmIds)) fail('WSL_PATH_UNSAFE', 'WSL storage ACL snapshot is incomplete')
  const base = new Set([String(snapshot.currentName).toLowerCase(), String(snapshot.currentSid).toLowerCase(), 'nt authority\\system', 's-1-5-18'])
  const runningWslVmIds = new Set(snapshot.runningWslVmIds.map(value => String(value).toLowerCase()))
  for (const [index, item] of snapshot.items.entries()) {
    const owner = String(item.owner || '').toLowerCase(), ownerSid = String(item.ownerSid || '').toLowerCase()
    if (!base.has(owner) && !base.has(ownerSid)) fail('WSL_PATH_UNSAFE', 'WSL storage has a foreign owner')
    for (const rule of item.rules || []) {
      if (String(rule.type).toLowerCase() !== 'allow') continue
      const identity = String(rule.identity || '').toLowerCase(), sid = String(rule.sid || '').toLowerCase()
      if (base.has(identity) || base.has(sid)) continue
      const vmMatch = identity.match(/^nt virtual machine\\([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/u)
      const vmPrincipal = Boolean(vmMatch && runningWslVmIds.has(vmMatch[1]))
      const wslCapability = identity === WSL_VHD_CAPABILITY_SID || sid === WSL_VHD_CAPABILITY_SID
      if (index !== 1 || (!vmPrincipal && !wslCapability) || rule.inherited === true || String(rule.rights) !== 'FullControl') fail('WSL_PATH_UNSAFE', 'WSL storage grants access to an unapproved identity')
    }
  }
  return { valid: true, mechanism: 'windows-wsl-vhd-dacl' }
}
function runningWslVmIds(output) {
  return [...String(output || '').matchAll(/Running,\s*([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}),\s*WSL\s*$/gimu)].map(match => match[1].toLowerCase())
}
function auditWslPrivateRoot(root) {
  const privacy = require('../agents/codex/workflow/safe-run-root.js')
  const descriptor = path.join(root, 'backend.json'), prepared = path.join(root, 'prepared.json')
  privacy.auditPrivatePermissions(root, { recurse: false, additionalPaths: [descriptor, prepared] })
  const names = fs.readdirSync(root).sort()
  const expected = fs.existsSync(prepared) ? ['backend.json', 'distribution', 'prepared.json'] : ['backend.json', 'distribution']
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail('WSL_PATH_UNSAFE', 'Private WSL root contains an unexpected host object')
  const distribution = path.join(root, 'distribution'), vhd = path.join(distribution, 'ext4.vhdx')
  const directory = fs.lstatSync(distribution, { bigint: true }), image = fs.lstatSync(vhd, { bigint: true })
  if (!directory.isDirectory() || directory.isSymbolicLink() || fs.realpathSync(distribution) !== distribution || JSON.stringify(fs.readdirSync(distribution)) !== JSON.stringify(['ext4.vhdx']) || !image.isFile() || image.isSymbolicLink() || image.nlink !== 1n || fs.realpathSync(vhd) !== vhd) fail('WSL_PATH_UNSAFE', 'Private WSL distribution storage is not an exact physical VHD')
  const script = [
    "$ErrorActionPreference='Stop'", '$identity=[Security.Principal.WindowsIdentity]::GetCurrent()', '$items=@()',
    'foreach($p in @($env:AUTOPROMPT_WSL_DISTRIBUTION,$env:AUTOPROMPT_WSL_VHD)){', '$acl=Get-Acl -LiteralPath $p',
    '$ownerSid=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value',
    '$rules=@($acl.Access|ForEach-Object{$sid=$null;try{$sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}catch{};[pscustomobject]@{identity=$_.IdentityReference.Value;sid=$sid;type=$_.AccessControlType.ToString();inherited=$_.IsInherited;rights=$_.FileSystemRights.ToString()}})',
    '$items+=[pscustomobject]@{path=$p;owner=$acl.Owner;ownerSid=$ownerSid;rules=$rules}', '}',
    '[pscustomobject]@{currentName=$identity.Name;currentSid=$identity.User.Value;items=$items}|ConvertTo-Json -Compress -Depth 7',
  ].join(';')
  const result = invoke(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...controlledEnv(root), AUTOPROMPT_WSL_DISTRIBUTION: distribution, AUTOPROMPT_WSL_VHD: vhd }, cwd: path.win32.dirname(powershellPath()) })
  let snapshot
  try { snapshot = JSON.parse(result.stdout) } catch { fail('WSL_PATH_UNSAFE', 'WSL storage ACL audit returned invalid JSON') }
  const hcsdiag = path.win32.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'hcsdiag.exe')
  const hcs = invoke(hcsdiag, ['list'], { env: controlledEnv(root), cwd: path.win32.dirname(hcsdiag) })
  snapshot.runningWslVmIds = runningWslVmIds(hcs.stdout)
  return validateWslStorageAcl(snapshot)
}
function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return path.win32.join(systemRoot, POWERSHELL_RELATIVE)
}
function invoke(executable, argv, options = {}) {
  const result = childProcess.spawnSync(executable, argv, { shell: false, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 45 * 60 * 1000, ...options })
  if (result.error || result.status || result.status !== 0) fail('WSL_COMMAND_FAILED', `WSL command failed: status=${result.status} signal=${result.signal || ''} error=${result.error?.code || ''} ${String(result.stderr || '').slice(-2048)}`)
  return result
}
function wslArgs(distribution, command) {
  if (!/^apwsl-[a-f0-9]{16}$/.test(distribution)) fail('WSL_DESCRIPTOR_INVALID', 'Invalid private WSL distribution name')
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || value.includes('\0'))) fail('WSL_COMMAND_INVALID', 'Invalid WSL guest command')
  return ['--distribution', distribution, '--user', 'root', '--exec', ...command]
}
function runGuestSync(descriptor, command, options = {}) {
  return invoke(descriptor.wsl.path, wslArgs(descriptor.distribution, command), { env: controlledEnv(descriptor.privateRoot.path), ...options })
}
function writeGuestFile(descriptor, destination, bytes, mode = '600') {
  if (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(destination) || !/^(?:600|700)$/.test(mode)) fail('WSL_COMMAND_INVALID', 'Invalid fixed guest file destination')
  runGuestSync(descriptor, ['/bin/sh', '-ceu', 'umask 077; cat > "$1"; chown autoprompt:autoprompt "$1"; chmod "$2" "$1"', '--', destination, mode], { input: bytes, encoding: Buffer.isBuffer(bytes) ? null : 'utf8' })
}
function bootstrapScript() {
  return [
    'test "$(id -u)" = 0',
    "if ! getent group autoprompt >/dev/null; then existing_group=$(getent group 1000 | cut -d: -f1 || true); if test -n \"$existing_group\"; then groupmod -n autoprompt \"$existing_group\"; else groupadd --gid 1000 autoprompt; fi; fi",
    "if ! id autoprompt >/dev/null 2>&1; then existing_user=$(getent passwd 1000 | cut -d: -f1 || true); if test -n \"$existing_user\"; then usermod -l autoprompt -d /home/autoprompt -m \"$existing_user\"; else useradd --create-home --uid 1000 --gid autoprompt --shell /bin/bash autoprompt; fi; fi",
    'usermod -g autoprompt autoprompt; test "$(id -u autoprompt)" = 1000; test "$(id -g autoprompt)" = 1000',
    `install -d -m 700 -o autoprompt -g autoprompt ${GUEST_ROOT}`,
    `install -d -m 700 -o autoprompt -g autoprompt ${GUEST_TARGET}`,
    `install -d -m 700 -o autoprompt -g autoprompt ${GUEST_ROOT}/providers ${GUEST_ROOT}/pinned ${GUEST_ROOT}/native ${GUEST_ROOT}/imports`,
    "printf '%s\\n' '[automount]' 'enabled=false' 'mountFsTab=false' '[interop]' 'enabled=false' 'appendWindowsPath=false' > /etc/wsl.conf",
    'chmod 600 /etc/wsl.conf',
  ].join('; ')
}
function guestPrerequisiteScript(provider) {
  if (!PUBLIC_PROVIDERS.has(provider)) fail('WSL_PROVIDER_CONFIG_INVALID', 'Provider is not a public Autoprompt provider')
  const vscodeProvision = provider === 'vscode'
    ? '\nresolve_candidate() {\n  for package in "$@"; do\n    if apt-cache show "$package" 2>/dev/null | grep -q "^Package: "; then printf "%s\\n" "$package"; return 0; fi\n  done\n  return 1\n}\ngtk_package=$(resolve_candidate libgtk-3-0t64 libgtk-3-0)\nasound_package=$(resolve_candidate libasound2t64 libasound2)\napt-get install -y xvfb xauth "$gtk_package" libnss3 "$asound_package" libx11-xcb1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libdrm2 libatk-bridge2.0-0 libcups2 x11-utils\ncommand -v Xvfb; command -v xauth; command -v xdpyinfo\n'
    : ''
  return `export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends bubblewrap git python3 python3-jsonschema; command -v bwrap; command -v git; command -v python3; ${vscodeProvision}`
}
function mountScript() {
  return `set -eu; command -v bwrap >/dev/null; command -v git >/dev/null; python3 -c 'import jsonschema'; target=${GUEST_TARGET}; if /bin/mountpoint -q "$target"; then type=$(/usr/bin/findmnt -n -o FSTYPE --target "$target"); case "$type" in 9p|drvfs) :;; *) exit 71;; esac; else /bin/mount -t drvfs "$1" "$target" -o metadata,uid=1000,gid=1000,umask=077,fmask=077; fi; exec /usr/sbin/runuser -u autoprompt -- "$2" "$3"`
}
function bridgeArgs(descriptor) {
  return wslArgs(descriptor.distribution, ['/bin/sh', '-ceu', mountScript(), '--', descriptor.target.path, `${nodeRoot(descriptor)}/bin/node`, `${GUEST_ROOT}/lima-runtime-guest.cjs`])
}
function nodeRoot(descriptor) { return `${GUEST_ROOT}/pinned/toolchain/node-v22.23.2-linux-${descriptor.arch === 'aarch64' ? 'arm64' : 'x64'}` }
function makeDescriptor(input, records) {
  return { schemaVersion: 1, kind: 'wsl2-linux-controller-v1', status: 'PREPARING', distribution: input.distribution,
    privateRoot: records.privateRoot, target: records.target, wsl: records.wsl, rootfs: records.rootfs, archive: records.archive,
    toolchainArchive: records.toolchainArchive, nativeArchive: records.nativeArchive, connection: records.connection,
    credential: records.credential, ...(records.modelSelection ? { modelSelection: records.modelSelection } : {}),
    bridge: records.bridge, lifecycle: records.lifecycle, worker: records.worker,
    ...(input.provider === 'vscode' ? { vscodeDisplay: records.vscodeDisplay } : {}),
    powerShell: records.powerShell, powerShellExe: records.powerShellExe,
    provider: input.provider, endpoint: input.endpoint, arch: input.arch, connectionName: records.connectionName,
    connectionIdentitySha256: records.connectionIdentitySha256, installDirectory: input.installDirectory }
}
function setup(input, options = {}) {
  if ((options.platform || process.platform) !== 'win32') fail('WSL_HOST_PLATFORM', 'This backend setup requires Windows')
  if (!PUBLIC_PROVIDERS.has(input.provider)) fail('WSL_PROVIDER_CONFIG_INVALID', 'Provider is not a public Autoprompt provider')
  if (!['x86_64', 'aarch64'].includes(input.arch)) fail('WSL_ARCH_INVALID', 'WSL guest architecture must be x86_64 or aarch64')
  const root = windowsPath(input.root, 'Backend root'), targetPath = windowsPath(input.target, 'Target'), installDirectory = path.win32.join(root, 'distribution')
  const wsl = binding(windowsPath(input.wsl, 'WSL executable')), rootfs = binding(windowsPath(input.rootfs, 'Rootfs archive'))
  const archive = binding(windowsPath(input.archive, 'Package archive')), toolchainArchive = binding(windowsPath(input.toolchainArchive, 'Toolchain archive')), nativeArchive = binding(windowsPath(input.nativeArchive, 'Native archive'))
  verifyDigest(rootfs, input.rootfsSha256, 'Rootfs archive'); verifyDigest(toolchainArchive, input.toolchainSha256, 'Toolchain archive'); verifyDigest(nativeArchive, input.nativeSha256, 'Native archive')
  const target = binding(targetPath, true)
  if (targetPath.toLowerCase() === root.toLowerCase() || targetPath.toLowerCase().startsWith(root.toLowerCase() + '\\') || root.toLowerCase().startsWith(targetPath.toLowerCase() + '\\')) fail('WSL_PATH_UNSAFE', 'Private state and exported target must be disjoint')
  const hostConnection = lima.connectionBinding(input.connection, input.provider, lima.providerEndpoint(input.endpoint))
  const hostCredential = lima.credentialBinding(input.credential, input.provider, hostConnection)
  const modelSelection = input.modelSelection ? lima.modelSelectionBinding(input.modelSelection, input.provider) : null
  const script = binding(path.join(__dirname, 'wsl-runtime.ps1')), bridge = binding(path.join(__dirname, 'lima-runtime-guest.cjs')), lifecycle = binding(path.join(__dirname, 'lima-runtime-guest-lifecycle.cjs')), worker = binding(path.join(__dirname, 'lima-runtime-guest-worker.cjs'))
  const vscodeDisplay = input.provider === 'vscode' ? binding(path.join(__dirname, 'lima-runtime-vscode-display.cjs')) : null
  const ps = binding(powershellPath(), false, true)
  const resuming = fs.existsSync(root)
  if (resuming && input.resume !== true) fail('WSL_SETUP_EXISTS', 'Existing WSL setup requires explicit resume')
  if (!resuming) fs.mkdirSync(root)
  if ((options.platform || process.platform) === 'win32' && !options.skipAcl) {
    const privacy = require('../agents/codex/workflow/safe-run-root.js')
    privacy.ensureWindowsPrivateAcl(root); privacy.auditPrivatePermissions(root, { recurse: false })
  }
  const privateRoot = binding(root, true), distribution = input.distribution || `apwsl-${crypto.randomBytes(8).toString('hex')}`
  const records = { privateRoot, target, wsl, rootfs, archive, toolchainArchive, nativeArchive, connection: hostConnection, credential: hostCredential, modelSelection, bridge, lifecycle, worker, vscodeDisplay, powerShell: script, powerShellExe: ps, connectionName: hostConnection.name, connectionIdentitySha256: hostConnection.connectionIdentitySha256 }
  const descriptor = makeDescriptor({ ...input, distribution, endpoint: lima.providerEndpoint(input.endpoint), installDirectory }, records)
  const descriptorPath = path.join(root, 'backend.json')
  if (resuming) {
    const previous = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
    descriptor.distribution = previous.distribution
    const comparable = value => { const copy = { ...value, status: 'PREPARING' }; delete copy.closure; return copy }
    if (JSON.stringify(comparable(previous)) !== JSON.stringify(comparable(descriptor))) fail('WSL_BINDING_CHANGED', 'Resume bindings differ from the original setup')
    if (previous.status === 'CONFIGURED') return { descriptor: load(root, options), guestOutput: '' }
    if (previous.status !== 'PREPARING') fail('WSL_DESCRIPTOR_INVALID', 'Existing setup cannot be resumed from its recorded state')
  } else fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' })
  const action = resuming ? 'resume' : 'import'
  invoke(ps.path, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script.path, '-Action', action, '-WslExe', wsl.path, '-Distribution', descriptor.distribution, '-InstallDirectory', installDirectory, '-Rootfs', rootfs.path], { env: controlledEnv(root) })
  runGuestSync(descriptor, ['/bin/sh', '-ceu', bootstrapScript()])
  const observedArch = runGuestSync(descriptor, ['/bin/uname', '-m']).stdout.trim()
  if (observedArch !== descriptor.arch) fail('WSL_ARCH_MISMATCH', `Imported WSL guest architecture ${observedArch || 'unknown'} does not match ${descriptor.arch}`)
  runGuestSync(descriptor, ['/bin/sh', '-ceu', guestPrerequisiteScript(input.provider)], { timeout: 30 * 60 * 1000 })
  invoke(wsl.path, ['--terminate', descriptor.distribution], { env: controlledEnv(root) })
  runGuestSync(descriptor, ['/bin/true'])
  if (resuming) runGuestSync(descriptor, ['/bin/sh', '-ceu', `rm -rf ${GUEST_ROOT}; install -d -m 700 -o autoprompt -g autoprompt ${GUEST_ROOT} ${GUEST_TARGET} ${GUEST_ROOT}/providers ${GUEST_ROOT}/pinned ${GUEST_ROOT}/native ${GUEST_ROOT}/imports`])
  writeGuestFile(descriptor, `${GUEST_ROOT}/package.tgz`, fs.readFileSync(archive.path))
  writeGuestFile(descriptor, `${GUEST_ROOT}/lima-runtime-guest.cjs`, fs.readFileSync(bridge.path), '700')
  writeGuestFile(descriptor, `${GUEST_ROOT}/lima-runtime-guest-lifecycle.cjs`, fs.readFileSync(lifecycle.path), '700')
  writeGuestFile(descriptor, `${GUEST_ROOT}/lima-runtime-guest-worker.cjs`, fs.readFileSync(worker.path), '700')
  if (vscodeDisplay) writeGuestFile(descriptor, `${GUEST_ROOT}/lima-runtime-vscode-display.cjs`, fs.readFileSync(vscodeDisplay.path), '700')
  writeGuestFile(descriptor, `${GUEST_ROOT}/imports/toolchain.tar`, fs.readFileSync(toolchainArchive.path))
  writeGuestFile(descriptor, `${GUEST_ROOT}/imports/native.tar`, fs.readFileSync(nativeArchive.path))
  writeGuestFile(descriptor, '/root/autoprompt-extract.py', EXTRACTOR, '700')
  const providerRoot = `${GUEST_ROOT}/providers/${input.provider}`
  runGuestSync(descriptor, ['/bin/sh', '-ceu', `install -d -m 700 -o autoprompt -g autoprompt "$1"; python3 /root/autoprompt-extract.py "$2" "$3" preserve; python3 /root/autoprompt-extract.py "$4" "$5" strip-one; chown -R autoprompt:autoprompt ${GUEST_ROOT}; chmod -R go-w ${GUEST_ROOT}/pinned ${GUEST_ROOT}/native`, '--', providerRoot, `${GUEST_ROOT}/imports/toolchain.tar`, `${GUEST_ROOT}/pinned/toolchain`, `${GUEST_ROOT}/imports/native.tar`, `${GUEST_ROOT}/native/${input.provider}`])
  const node = `${nodeRoot(descriptor)}/bin/node`
  const digestOutput = runGuestSync(descriptor, [node, '-e', `const g=require(${JSON.stringify(`${GUEST_ROOT}/lima-runtime-guest.cjs`)});console.log(JSON.stringify({toolchain:g.portableTreeDigest(${JSON.stringify(nodeRoot(descriptor))}),native:g.portableTreeDigest(${JSON.stringify(`${GUEST_ROOT}/native/${input.provider}`)})}))`]).stdout.trim()
  let closure
  try { closure = JSON.parse(digestOutput) } catch { fail('WSL_IMPORT_INVALID', 'Guest closure digest output was invalid') }
  const providerConfig = { schemaVersion: 2, kind: 'lima-guest-provider-config-v1', hostBackend: 'wsl2-drvfs', hostTargetSha256: crypto.createHash('sha256').update(target.path.toLowerCase()).digest('hex'), provider: input.provider, endpoint: descriptor.endpoint, target: GUEST_TARGET,
    credentialSha256: hostCredential.sha256, connectionSha256: hostConnection.sha256, connectionIdentitySha256: hostConnection.connectionIdentitySha256, connectionName: hostConnection.name,
    nativeSha256: closure.native, toolchainSha256: closure.toolchain, ...(modelSelection ? { modelSelectionSha256: modelSelection.sha256 } : {}) }
  writeGuestFile(descriptor, `${providerRoot}/${hostConnection.name}`, fs.readFileSync(hostConnection.path))
  writeGuestFile(descriptor, `${providerRoot}/credentials.json`, fs.readFileSync(hostCredential.path))
  if (modelSelection) writeGuestFile(descriptor, `${providerRoot}/.autoprompt-${input.provider}-models.json`, fs.readFileSync(modelSelection.path))
  writeGuestFile(descriptor, `${GUEST_ROOT}/provider-config.json`, `${JSON.stringify(providerConfig)}\n`)
  writeGuestFile(descriptor, `${GUEST_ROOT}/target.json`, `${JSON.stringify({ target: GUEST_TARGET })}\n`)
  const setupRequest = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'setup', archiveSha256: archive.sha256 })))
  const guestOutput = runGuestSync(descriptor, ['/bin/sh', '-ceu', mountScript(), '--', target.path, node, `${GUEST_ROOT}/lima-runtime-guest.cjs`], { input: `${JSON.stringify(setupRequest)}\n` }).stdout
  descriptor.status = 'CONFIGURED'; descriptor.closure = closure
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`)
  fs.writeFileSync(path.join(root, 'prepared.json'), `${JSON.stringify({ schemaVersion: 1, distribution: descriptor.distribution, providerConfigSha256: crypto.createHash('sha256').update(JSON.stringify(providerConfig) + '\n').digest('hex'), closure })}\n`, { flag: resuming ? 'w' : 'wx' })
  return { descriptor, guestOutput }
}
function load(root, options = {}) {
  const file = path.join(root, 'backend.json'), descriptor = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (descriptor.schemaVersion !== 1 || descriptor.kind !== 'wsl2-linux-controller-v1' || descriptor.status !== 'CONFIGURED' || descriptor.privateRoot?.path !== root || !PUBLIC_PROVIDERS.has(descriptor.provider) || !['x86_64','aarch64'].includes(descriptor.arch) || !/^apwsl-[a-f0-9]{16}$/.test(descriptor.distribution) || !descriptor.closure || !fs.existsSync(path.join(root, 'prepared.json'))) fail('WSL_DESCRIPTOR_INVALID', 'Invalid or incomplete WSL backend descriptor')
  if ((options.platform || process.platform) === 'win32' && !options.skipAcl) auditWslPrivateRoot(root)
  assertBinding(descriptor.privateRoot, true); assertBinding(descriptor.target, true)
  for (const key of ['wsl','rootfs','archive','toolchainArchive','nativeArchive','bridge','lifecycle','worker','powerShell','powerShellExe']) assertBinding(descriptor[key])
  assertVscodeDisplayDescriptor(descriptor)
  const connection = lima.connectionBinding(descriptor.connection.path, descriptor.provider, descriptor.endpoint)
  assertSemanticBinding(descriptor.connection, connection, 'Native connection')
  assertSemanticBinding(descriptor.credential, lima.credentialBinding(descriptor.credential.path, descriptor.provider, connection), 'Credential')
  if (descriptor.modelSelection) assertSemanticBinding(descriptor.modelSelection, lima.modelSelectionBinding(descriptor.modelSelection.path, descriptor.provider), 'Model selection')
  return descriptor
}
function assertVscodeDisplayDescriptor(descriptor) {
  const expected = descriptor?.provider === 'vscode'
  if (expected !== Boolean(descriptor?.vscodeDisplay)) fail('WSL_DESCRIPTOR_INVALID', 'WSL VS Code display binding does not match the configured provider')
  if (expected) assertBinding(descriptor.vscodeDisplay)
  return true
}
function requestId(value) { return lima.requestId(value) }
function transport(descriptor, root, request) {
  return new Promise(resolve => {
    const child = childProcess.spawn(descriptor.wsl.path, bridgeArgs(descriptor), { shell: false, windowsHide: true, env: controlledEnv(root), stdio: ['pipe','pipe','pipe'] })
    const stdout = [], stderr = []; let bytes = 0, settled = false
    const append = (list, chunk) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) child.kill('SIGTERM'); else list.push(chunk) }
    child.stdout.on('data', chunk => append(stdout, chunk)); child.stderr.on('data', chunk => append(stderr, chunk))
    child.once('error', error => { if (!settled) { settled = true; resolve({ schemaVersion: 1, status: 'UNKNOWN', requestId: request.requestId, transportError: error.code || 'SPAWN_FAILED' }) } })
    child.once('close', code => { if (settled) return; settled = true; const text = Buffer.concat(stdout).toString('utf8').trim(); if (code === 0 && text) { try { return resolve(JSON.parse(text)) } catch {} } resolve({ schemaVersion: 1, status: 'UNKNOWN', requestId: request.requestId, transportError: `WSL_EXIT_${code ?? 'UNKNOWN'}`, stderr: Buffer.concat(stderr).toString('utf8').slice(-2048) }) })
    child.stdin.once('error', () => {}); child.stdin.write(`${JSON.stringify(request)}\n`)
  })
}
function exec(input) { const id = requestId(input.requestId), request = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'exec', requestId: id, argv: input.argv }))), descriptor = load(input.root); if (typeof input.onRequest === 'function') input.onRequest(id); return transport(descriptor, input.root, request) }
function status(input) { const request = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'status', ...(input.requestId ? { requestId: requestId(input.requestId) } : {}) }))); return transport(load(input.root), input.root, request) }
function cancel(input) { const id = requestId(input.requestId), request = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'cancel', requestId: id }))); return transport(load(input.root), input.root, request) }

module.exports = { setup, load, status, exec, cancel, transport, binding, assertBinding, assertSemanticBinding, assertVscodeDisplayDescriptor, sha256File, windowsPath, exactDigest, controlledEnv, powershellPath, wslArgs, bridgeArgs, nodeRoot, bootstrapScript, guestPrerequisiteScript, mountScript, makeDescriptor, validateWslStorageAcl, runningWslVmIds, auditWslPrivateRoot, GUEST_TARGET, EXTRACTOR }
