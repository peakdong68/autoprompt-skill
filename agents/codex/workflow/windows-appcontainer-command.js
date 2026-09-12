'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { ensureWindowsPrivateAcl } = require('./safe-run-root.js')
const { createWindowsFilesystemCapture } = require('./windows-filesystem.js')
const { createWindowsAppContainerLauncher, WindowsAppContainerError } = require('./windows-appcontainer.js')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function bindRuntimeFile(file, maxBytes) {
  const canonical = fs.realpathSync.native(file)
  if (canonical.toLowerCase() !== path.resolve(file).toLowerCase()) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime paths must be canonical')
  for (let cursor = canonical; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (cursor !== canonical && !stat.isDirectory())) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime ancestry must be physical')
    if (cursor === path.parse(cursor).root) break
  }
  const descriptor = fs.openSync(canonical, 'r')
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) throw new WindowsAppContainerError('WINDOWS_RUNTIME_INVALID', 'Git Bash runtime file is not bounded and physical')
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true })
    if (bytes.length !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Git Bash runtime changed while binding')
    return Object.freeze({ path: canonical, bytes, sha256: sha256(bytes) })
  } finally { fs.closeSync(descriptor) }
}
function resolveWindowsBash(options = {}) {
  const environment = process.env
  const candidates = [options.bashPath, environment.AUTOPROMPT_WINDOWS_BASH]
  const bases = [environment.ProgramW6432, environment.ProgramFiles, environment['ProgramFiles(x86)'],
    'C:\\Program Files', 'C:\\Program Files (x86)', environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Programs')].filter(Boolean)
  for (const base of bases) candidates.push(path.join(base, 'Git', 'usr', 'bin', 'bash.exe'), path.join(base, 'Git', 'bin', 'bash.exe'))
  for (const requested of [...new Set(candidates.filter(Boolean))]) {
    try {
      const bash = bindRuntimeFile(requested, 16 * 1024 * 1024)
      const runtimeDirectory = path.dirname(bash.path)
      const msys = bindRuntimeFile(path.join(runtimeDirectory, 'msys-2.0.dll'), 16 * 1024 * 1024)
      const version = cp.spawnSync(bash.path, ['--version'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false, cwd: runtimeDirectory,
        env: { SystemRoot: environment.SystemRoot, WINDIR: environment.SystemRoot, SystemDrive: environment.SystemDrive || environment.SystemRoot.slice(0, 2), PATH: runtimeDirectory },
      })
      const match = /GNU bash, version (\d+)\.(\d+)/.exec(version.stdout || '')
      if (!version.error && version.status === 0 && match && (+match[1] > 4 || +match[1] === 4 && +match[2] >= 3)) return Object.freeze({ bash, msys })
    } catch (_) {}
  }
  throw new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', 'Git Bash 4.3 or newer is required for the Windows command boundary')
}
async function runWindowsAppContainerCommand(policy, args, options = {}) {
  if (process.platform !== 'win32' || typeof options.controlRoot !== 'string' || !path.isAbsolute(options.controlRoot)) throw new WindowsAppContainerError('COMMAND_SANDBOX_UNSUPPORTED', 'A private controller root is required for Windows commands')
  const controlRoot = fs.realpathSync.native(options.controlRoot)
  const capture = createWindowsFilesystemCapture()
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const cancellationPath = path.join(controlRoot, `cancel-${nonce}`)
  const runtimeDirectory = path.join(path.dirname(controlRoot), `command-runtime-${nonce}`)
  const runtimeNode = path.join(runtimeDirectory, 'node.exe'), runtimeBash = path.join(runtimeDirectory, 'bash.exe')
  const runtimeMsys = path.join(runtimeDirectory, 'msys-2.0.dll')
  const launcher = createWindowsAppContainerLauncher()
  const { prepareWindowsAppContainerResources, recoverWindowsAppContainerResources } = require('./windows-appcontainer-resources.js')
  const bashSource = resolveWindowsBash(options)
  const systemRoot = process.env.SystemRoot
  const executable = runtimeBash, executableSha256 = bashSource.bash.sha256
  const start = Date.now()
  let lease, evidence, released = false, recoveryPending = false, privateScratch = null
  try {
    if (!policy.scratchPath) {
      privateScratch = path.join(path.dirname(controlRoot), `command-scratch-${nonce}`)
      fs.mkdirSync(privateScratch, { mode: 0o700 }); ensureWindowsPrivateAcl(privateScratch)
      policy = { ...policy, scratchPath: privateScratch, readableRoots: [...policy.readableRoots, privateScratch], writableRoots: [...policy.writableRoots, privateScratch] }
    }
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 })
    ensureWindowsPrivateAcl(runtimeDirectory)
    const expectedNodeHash = sha256(fs.readFileSync(process.execPath))
    fs.copyFileSync(process.execPath, runtimeNode, fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(runtimeBash, bashSource.bash.bytes, { flag: 'wx', mode: 0o500 })
    fs.writeFileSync(runtimeMsys, bashSource.msys.bytes, { flag: 'wx', mode: 0o400 })
    if (sha256(fs.readFileSync(runtimeNode)) !== expectedNodeHash) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Controller Node changed while copying')
    if (sha256(fs.readFileSync(runtimeBash)) !== executableSha256 || sha256(fs.readFileSync(runtimeMsys)) !== bashSource.msys.sha256) throw new WindowsAppContainerError('WINDOWS_RUNTIME_MISMATCH', 'Git Bash runtime changed while copying')
    lease = await prepareWindowsAppContainerResources({ policy, controlRoot,
      executableRoots: [{ path: runtimeDirectory, kind: 'directory' }],
      verifyDrainEvidence: launcher.verifyDrainEvidence })
    const env = {
      SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'), LOCALAPPDATA: process.env.LOCALAPPDATA || '',
      PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: runtimeDirectory, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1',
      NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main', AUTOPROMPT_APP_CONTAINER_SID: lease.profileSid,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing',
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'core.sshCommand', GIT_CONFIG_VALUE_2: 'cmd /d /c exit 1',
      ...lease.environment,
    }
    evidence = await launcher.launch({ profileName: lease.profileName, profileSid: lease.profileSid,
      executable, executableSha256, arguments: ['--noprofile', '--norc', '-c', args.command], cwd: args.cwd,
      environment: Object.entries(env).map(([key, value]) => `${key}=${value}`), timeoutMs: args.timeoutMs || 60000,
      outputLimit: 1024 * 1024, cancellationPath }, { signal: options.signal, leaseId: lease.recovery.leaseId })
    await lease.release(evidence)
    released = true
    const stdout = evidence.stdout, stderr = evidence.stderr, output = Buffer.concat([stdout, stderr])
    return { tool: 'bash', command: args.command, cwd: args.cwd,
      status: evidence.exitCode === 0 && !evidence.timedOut && !evidence.truncated && !evidence.cancelled ? 'completed' : 'failed',
      exitCode: evidence.exitCode, signal: null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), output: output.toString('utf8'),
      stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'), outputBase64: output.toString('base64'), outputSha256: sha256(output),
      launcherSessionId: evidence.launcherSessionId, truncated: evidence.truncated, cancelled: evidence.cancelled, timedOut: evidence.timedOut, background: false, durationMs: Date.now() - start }
  } catch (error) {
    if (!lease && error.recovery) {
      recoveryPending = true
      const binding = { profileSid: error.recovery.profileSid, leaseId: error.recovery.leaseId }
      const unused = launcher.proveNotStarted(binding)
      await recoverWindowsAppContainerResources({ controlRoot, journalPath: error.recovery.journalPath, verifyDrainEvidence: launcher.verifyDrainEvidence, evidence: unused })
      recoveryPending = false; released = true; error.recoveryResolved = true
    }
    if (lease && !evidence) {
      let unused
      try { unused = launcher.proveNotStarted({ profileSid: lease.profileSid, leaseId: lease.recovery.leaseId }) } catch {}
      if (unused) { await lease.release(unused); released = true }
    }
    if (lease && !released) error.recovery = Object.freeze({ ...lease.recovery, profileSid: lease.profileSid })
    throw error
  } finally {
    // Unconfirmed launches retain their exact request artifacts alongside the
    // resource journal. Recovery must prove process drain before revoking grants.
    if ((!lease && !recoveryPending) || released) {
      if (privateScratch) fs.rmSync(privateScratch, { recursive: true, force: true })
      fs.rmSync(runtimeDirectory, { recursive: true, force: true })
      try { fs.unlinkSync(cancellationPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}
module.exports = { runWindowsAppContainerCommand }
