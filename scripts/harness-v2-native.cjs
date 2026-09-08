'use strict'

// Provider interfaces are deliberately separate from runtime admission. A help
// probe is evidence of a CLI surface, never a sandbox or conformance receipt.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { readBound, sha256, privateDirectory, writePrivate } = require('../agents/reasonix/workflow/native.js')
class HarnessError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'HarnessError'; this.code = code; this.details = details }
}
const fail = (code, message, details) => { throw new HarnessError(code, message, details) }
const PROVIDERS = Object.freeze(Object.fromEntries(Object.entries({
  claude: { command: 'claude', protocol: 'claude-json', helpArgs: ['--help'], flags: ['--print', '--output-format', '--include-partial-messages', '--resume', '--tools', '--settings', '--setting-sources', '--strict-mcp-config', '--bare', '--effort'], credentials: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], urls: ['ANTHROPIC_BASE_URL'], docs: 'https://code.claude.com/docs/en/cli-reference' },
  opencode: { command: 'opencode', protocol: 'opencode-json', helpArgs: ['run', '--help'], flags: ['--format', '--session', '--agent', '--model', '--variant'], credentials: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://opencode.ai/v2/docs/models' },
  kilo: { command: 'kilo', protocol: 'opencode-json', helpArgs: ['run', '--help'], flags: ['--format', '--session', '--agent', '--model', '--variant'], credentials: ['KILO_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://kilo.ai/docs/code-with-ai/platforms/cli-reference' },
  // Prime 0.7.2 is pinned because the ownership-safe headless path below uses
  // that release's shipped owned-session-worker frontend. Later releases must
  // be re-proved before they can silently fall back to a detached daemon path.
  prime: { command: 'prime-agent', protocol: 'pi-json', helpArgs: ['--help'], flags: ['--mode', '--resume', '--session-dir', '--no-tools', '--no-builtin-tools', '--no-extensions', '--no-skills', '--no-context-files', '--system-prompt', '--thinking'], versions: ['0.7.2'], credentials: ['PRIME_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.2/packages/coding-agent/docs/json.md' },
  omp: { command: 'omp', protocol: 'pi-json', helpArgs: ['--help'], flags: ['--mode', '--resume', '--session-dir', '--tools', '--no-extensions', '--no-skills', '--no-rules', '--system-prompt', '--no-lsp', '--no-pty', '--thinking'], credentials: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: [], docs: 'https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/print-mode.ts' },
  deepseek: { command: 'dsh', protocol: 'deepseek-json', helpArgs: ['--help'], flags: ['--profile', '--patch'], versions: ['0.1.2-rc.1'], credentials: ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], urls: ['DEEPSEEK_BASE_URL'], docs: 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/src/types.ts' },
  vscode: { command: 'code', protocol: 'vscode-owned-json', helpArgs: ['--help'], flags: ['--list-extensions', '--extensions-dir', '--user-data-dir'], credentials: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], urls: [], blockers: [], docs: 'https://code.visualstudio.com/api/extension-guides/ai/language-model' },
}).map(([id, descriptor]) => [id, Object.freeze({ id, provider: id, ...descriptor, flags: Object.freeze(descriptor.flags), versions: Object.freeze(descriptor.versions || []), credentials: Object.freeze(descriptor.credentials), urls: Object.freeze(descriptor.urls), blockers: Object.freeze(descriptor.blockers || []) })])))
function descriptor(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider)) fail('PROVIDER_UNSUPPORTED', `Unknown native provider: ${String(provider)}`)
  return PROVIDERS[provider]
}
function executableSha256(file) {
  // npm legitimately hard-links several native distributions. Private runtime
  // payloads still use readBound's one-link rule; executable trust is instead
  // bound to its exact open file identity and complete bytes.
  const before = fs.lstatSync(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink < 1n) fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable is not a regular file')
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!same(before, opened)) fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable changed while opening')
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0n
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (!length) break
      hash.update(buffer.subarray(0, length)); bytes += BigInt(length)
    }
    const after = fs.lstatSync(file, { bigint: true })
    if (bytes !== opened.size || !same(opened, fs.fstatSync(descriptor, { bigint: true })) || !same(opened, after) || after.isSymbolicLink()) {
      fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable changed while hashing')
    }
    return hash.digest('hex')
  } finally { fs.closeSync(descriptor) }
}
function locateExecutable({ provider, env = process.env, executable } = {}) {
  const d = descriptor(provider)
  const requested = executable || env[`AUTOPROMPT_${provider.toUpperCase()}_CLI`]
  const names = requested && path.isAbsolute(requested) ? [requested] : (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir => {
    const name = requested || d.command
    return process.platform === 'win32' ? [path.join(dir, `${name}.exe`), path.join(dir, `${name}.cmd`)] : [path.join(dir, name)]
  })
  for (const name of names) {
    try {
      let resolved = fs.realpathSync.native(name)
      if (provider === 'vscode' && path.basename(path.dirname(resolved)) === 'bin') {
        const electron = path.join(path.dirname(path.dirname(resolved)), process.platform === 'win32' ? 'Code.exe' : 'code')
        if (fs.existsSync(electron)) resolved = fs.realpathSync.native(electron)
      }
      if (/^(codex|codex\.exe|codex\.js)$/i.test(path.basename(resolved))) fail('PROVIDER_IDENTITY_MISMATCH', 'Codex is not a native executable for this provider')
      fs.accessSync(resolved, fs.constants.X_OK)
      return { provider, path: resolved, sha256: executableSha256(resolved) }
    } catch (error) { if (error.code === 'PROVIDER_IDENTITY_MISMATCH') throw error }
  }
  fail('PROVIDER_UNSUPPORTED', `${d.command} is not installed or executable`, { provider, command: d.command })
}
function runtimeDependencyIdentity(executable, environment = process.env) {
  const roots = new Set(), files = new Map()
  let totalBytes = 0
  const packageAt = start => {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      if (path.dirname(dir) === dir) return null
    }
  }
  const first = packageAt(path.dirname(executable))
  const record = file => {
    const real = fs.realpathSync.native(file)
    totalBytes += fs.statSync(real).size
    if (files.size >= 100000 || totalBytes > 8 * 1024 * 1024 * 1024) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency inventory exceeds its bounded size')
    files.set(file, [real, executableSha256(real)])
  }
  const visit = root => {
    root = fs.realpathSync.native(root)
    if (roots.has(root)) return
    if (roots.size >= 4096) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency inventory exceeds its package limit')
    roots.add(root)
    const manifestFile = path.join(root, 'package.json'), manifestBytes = fs.readFileSync(manifestFile)
    const manifest = JSON.parse(manifestBytes)
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (entry.isFile()) record(file)
        else if (entry.isSymbolicLink()) {
          const real = fs.realpathSync.native(file)
          if (!fs.statSync(real).isFile()) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime package contains an unbound directory symlink')
          record(file)
        }
      }
    }
    walk(root)
    if (sha256(manifestBytes) !== files.get(manifestFile)?.[1]) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency metadata changed while collecting identity')
    for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime dependency has an invalid package identity')
      let found = null
      for (let dir = root; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', name)
        if (fs.existsSync(path.join(candidate, 'package.json'))) { found = candidate; break }
        if (path.dirname(dir) === dir) break
      }
      if (found) visit(found)
      else if (Object.hasOwn(manifest.dependencies || {}, name) && !Object.hasOwn(manifest.optionalDependencies || {}, name)) fail('PROVIDER_IDENTITY_MISMATCH', `Runtime dependency is missing: ${name}`)
    }
  }
  const vscodeBundle = path.dirname(executable)
  if (fs.existsSync(path.join(vscodeBundle, 'resources/app/product.json')) && fs.existsSync(path.join(vscodeBundle, 'resources/app/package.json'))) {
    // Electron can stay byte-identical while the VS Code application changes.
    // Bind the complete shipped bundle, including ASARs, native modules and
    // built-in extensions. Never treat the Electron executable hash as enough.
    roots.add(vscodeBundle)
    const walkBundle = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walkBundle(file)
        else if (entry.isFile()) record(file)
        else if (entry.isSymbolicLink()) {
          if (!fs.statSync(file).isFile()) fail('PROVIDER_IDENTITY_MISMATCH', 'VS Code bundle contains an unbound directory link')
          record(file)
        }
      }
    }
    walkBundle(vscodeBundle)
  } else if (first) visit(first)
  record(executable)
  const header = Buffer.alloc(256), descriptor = fs.openSync(executable, 'r')
  let length
  try { length = fs.readSync(descriptor, header, 0, header.length, 0) } finally { fs.closeSync(descriptor) }
  const shebang = /^#!([^\r\n]+)/.exec(header.subarray(0, length).toString('utf8'))?.[1].trim().split(/\s+/)
  if (shebang) {
    let interpreter = shebang[0]
    if (path.basename(interpreter) === 'env') {
      if (shebang.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(shebang[1])) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime launcher has an unsupported interpreter selector')
      interpreter = (environment.PATH || '').split(path.delimiter).map(dir => path.join(dir, shebang[1])).find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
      })
    }
    if (!interpreter || !path.isAbsolute(interpreter)) fail('PROVIDER_IDENTITY_MISMATCH', 'Runtime launcher interpreter is unavailable')
    record(interpreter)
  }
  return Object.freeze({ sha256: sha256(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))), fileCount: files.size, packageCount: roots.size })
}
function isolatedEnvironment(root, environment = {}, credentials = {}) {
  const result = {}
  // Explicit allowlist: NODE_OPTIONS, plugin paths, shell startup files, and all
  // inherited provider configuration overrides must not reach the child.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'GIT_CONFIG_COUNT']) {
    if (typeof environment[key] === 'string') result[key] = environment[key]
  }
  // Preserve controller-owned Git safety projection, but no user Git config.
  if (/^\d+$/.test(result.GIT_CONFIG_COUNT || '')) for (let i = 0; i < Number(result.GIT_CONFIG_COUNT); i++) for (const suffix of ['KEY', 'VALUE']) {
    const key = `GIT_CONFIG_${suffix}_${i}`
    if (typeof environment[key] === 'string') result[key] = environment[key]
  }
  Object.assign(result, credentials, { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'), TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') })
  for (const dir of [root, result.XDG_CONFIG_HOME, result.XDG_DATA_HOME, result.XDG_STATE_HOME, result.XDG_CACHE_HOME, result.TMPDIR]) privateDirectory(dir)
  if (!fs.existsSync(result.GIT_CONFIG_GLOBAL)) writePrivate(result.GIT_CONFIG_GLOBAL, '')
  return result
}
function packageEvidence(packageRoot, expectedName, version) {
  let manifest
  try { manifest = JSON.parse(readBound(path.join(packageRoot, 'package.json')).toString('utf8')) } catch {
    fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK package metadata is unreadable: ${expectedName}`)
  }
  if (manifest.name !== expectedName || manifest.version !== version) {
    fail('PROVIDER_UNSUPPORTED', 'DeepSeek SDK package set does not match the probed CLI', {
      expectedName, expectedVersion: version, actualName: manifest.name, actualVersion: manifest.version,
    })
  }
  return manifest
}
function deepseekPackageRoot(executable) {
  let current = path.dirname(executable)
  for (let depth = 0; depth < 8; depth++) {
    const manifest = path.join(current, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(readBound(manifest)).name === '@deepseek-ai/dsh') return current
      } catch { /* Keep walking; the final refusal names the missing official package. */ }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail('PROVIDER_UNSUPPORTED', 'DeepSeek CLI is not bound to a readable official @deepseek-ai/dsh package')
}
function deepseekSdkCapabilityEvidence(binding, version) {
  const dshRoot = deepseekPackageRoot(binding.path)
  const scopeRoot = path.dirname(dshRoot)
  const packages = [
    'dsh', 'dsh-sdk-protocol', 'dsh-sdk-jsonrpc-server', 'dsh-sdk-minimal',
    'dsh-agent', 'dsh-session', 'dsh-token-meter', 'dsh-llm-deepseek',
  ]
  const versions = {}
  for (const name of packages) {
    const root = name === 'dsh' ? dshRoot : path.join(scopeRoot, name)
    const manifest = packageEvidence(root, `@deepseek-ai/${name}`, version)
    versions[manifest.name] = manifest.version
  }
  const evidenceFiles = {
    protocol: path.join(scopeRoot, 'dsh-sdk-protocol/lib/types/types.d.ts'),
    server: path.join(scopeRoot, 'dsh-sdk-jsonrpc-server/lib/index.js'),
    profile: path.join(scopeRoot, 'dsh-sdk-minimal/cordis.patch.yml'),
    agent: path.join(scopeRoot, 'dsh-agent/lib/types/index.d.ts'),
    session: path.join(scopeRoot, 'dsh-session/lib/types/types.d.ts'),
    tokenMeter: path.join(scopeRoot, 'dsh-token-meter/lib/types/turn-usage.js'),
    adapter: path.join(scopeRoot, 'dsh-llm-deepseek/lib/index.js'),
  }
  const text = {}, hashes = []
  for (const [name, file] of Object.entries(evidenceFiles)) {
    let bytes
    try { bytes = readBound(file) } catch { fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK capability source is unreadable: ${name}`) }
    if (bytes.length > 4 * 1024 * 1024) fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK capability source is unexpectedly large: ${name}`)
    text[name] = bytes.toString('utf8'); hashes.push(sha256(bytes))
  }
  const executableText = readBound(binding.path).toString('utf8')
  let launcher = /import\("\.\/(profile-boot-[A-Za-z0-9_-]+\.js)"\)/.exec(executableText)?.[1]
  if (!launcher) fail('PROVIDER_UNSUPPORTED', 'DeepSeek executable does not identify its process-shutdown module')
  let launch = ''
  const visitedLaunchers = new Set()
  for (let depth = 0; depth < 4; depth++) {
    if (visitedLaunchers.has(launcher)) fail('PROVIDER_UNSUPPORTED', 'DeepSeek process-shutdown module chain is cyclic')
    visitedLaunchers.add(launcher)
    const launcherBytes = readBound(path.join(dshRoot, 'lib', launcher))
    if (launcherBytes.length > 4 * 1024 * 1024) fail('PROVIDER_UNSUPPORTED', 'DeepSeek process-shutdown source is unexpectedly large')
    launch = launcherBytes.toString('utf8'); hashes.push(sha256(launcherBytes))
    if (launch.includes('process.on("SIGTERM"')) break
    const delegated = /from\s+["']\.\/(profile-boot-[A-Za-z0-9_-]+\.js)["']/.exec(launch)?.[1]
    if (!delegated) fail('PROVIDER_UNSUPPORTED', 'DeepSeek process-shutdown module does not expose its bounded implementation')
    launcher = delegated
  }

  // These are exact observations over the installed official SDK implementation,
  // not admission claims. A missing marker refuses the probe instead of turning
  // absence into a guessed capability value.
  const required = [
    [text.protocol, "'session/prompt'", 'SDK session/prompt request'],
    [text.protocol, "'session.event'", 'SDK session.event notification'],
    [text.server, 'ctx.on("session/event"', 'full session event forwarding'],
    [text.server, 'this.ctx.agents.create({', 'fresh SDK session creation'],
    [text.agent, 'resume(options:', 'native core resume API'],
    [text.session, "'tool/call'", 'tool call log event'],
    [text.session, "'tool/result'", 'tool result log event'],
    [text.tokenMeter, 'deriveTurnTokenUsage(events)', 'exact turn usage fold'],
    [text.adapter, 'prompt_cache_hit_tokens', 'DeepSeek cache usage mapping'],
    [text.adapter, 'stream_options: { include_usage: true }', 'provider usage streaming'],
    [text.profile, 'mode: danger-full-access', 'sdk-minimal sandbox mode'],
    [text.profile, "name: '@deepseek-ai/dsh-tool-bash-persistent'", 'sdk-minimal shell tool'],
    [text.profile, "name: '@deepseek-ai/dsh-tool-str-replace-editor'", 'sdk-minimal editor tool'],
    [launch, 'process.on("SIGTERM"', 'bounded SIGTERM shutdown'],
    [launch, 'await app.current?.fiber.dispose()', 'whole-tree shutdown drain'],
  ]
  for (const [source, marker, label] of required) if (!source.includes(marker)) {
    fail('PROVIDER_UNSUPPORTED', `DeepSeek SDK capability marker is missing: ${label}`)
  }
  const sdkResumeRequest = /['"]session\/(?:resume|continue)['"]/.test(text.protocol)
  const serverUsesResume = /this\.ctx\.agents\.resume\s*\(/.test(text.server)
  if (sdkResumeRequest || serverUsesResume) {
    fail('PROVIDER_UNSUPPORTED', 'DeepSeek SDK continuation surface changed; the fail-closed capability record must be revalidated')
  }
  return Object.freeze({
    packageVersions: Object.freeze(versions),
    evidenceHashes: Object.freeze(hashes),
    facts: Object.freeze({
      callerSuppliedSessionId: true,
      fullSessionEventStream: true,
      toolCallAndResultEvents: true,
      providerReportedExactUsage: true,
      gracefulProcessDrain: true,
      nativeCoreResumeApi: true,
      sdkCrossProcessContinuation: false,
      sdkAutopromptOnlyTools: false,
      sdkSafeSandbox: false,
      sdkDefaultSandboxMode: 'danger-full-access',
      sdkDefaultTools: Object.freeze(['bash', 'str_replace_editor']),
    }),
    blockers: Object.freeze(['SDK_CROSS_PROCESS_CONTINUATION_UNAVAILABLE', 'SDK_AUTOPROMPT_ONLY_TOOLS_UNAVAILABLE', 'SDK_SAFE_SANDBOX_UNAVAILABLE']),
  })
}
function probeExecutable(options = {}) {
  const d = descriptor(options.provider)
  const binding = locateExecutable(options)
  const timeout = options.timeoutMs ?? 30000
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120000) fail('PROVIDER_UNSUPPORTED', 'Native probe timeout must be bounded between 1 and 120 seconds')
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-native-probe-'))
  try {
    const env = isolatedEnvironment(probeRoot, options.env || process.env)
    const spawn = options.spawnSync || cp.spawnSync
    const invoke = argv => {
      const vscodeCli = path.join(path.dirname(binding.path), 'resources/app/out/cli.js')
      const nativeArgv = options.provider === 'vscode' && fs.existsSync(vscodeCli) ? [vscodeCli, ...argv] : argv
      const nativeEnv = nativeArgv === argv ? env : { ...env, ELECTRON_RUN_AS_NODE: '1' }
      const result = spawn(binding.path, nativeArgv, { cwd: probeRoot, env: nativeEnv, shell: false, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true })
      if (result.error || result.status !== 0 || result.signal) fail('PROVIDER_UNSUPPORTED', `${d.command} capability probe failed`, { argv, status: result.status, code: result.error?.code })
      return `${result.stdout || ''}\n${result.stderr || ''}`
    }
    const versionText = invoke(['--version'])
    if (/\bcodex\b/i.test(versionText)) fail('PROVIDER_IDENTITY_MISMATCH', 'Executable identifies itself as Codex')
    const version = /(?:^|[^A-Za-z0-9])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[^A-Za-z0-9.+-])/.exec(versionText)?.[1]
    if (!version) fail('PROVIDER_UNSUPPORTED', `${d.command} did not report a recognizable native version`)
    if (d.versions.length && !d.versions.includes(version)) {
      fail('PROVIDER_UNSUPPORTED', `${d.command} ${version} has not been verified for this native transport`, { version, supportedVersions: [...d.versions] })
    }
    const help = invoke(d.helpArgs)
    const missing = d.flags.filter(flag => !help.includes(flag))
    if (missing.length) fail('PROVIDER_UNSUPPORTED', `${d.command} lacks the required native CLI interface`, { missing, version })
    const deepseekSdk = options.provider === 'deepseek' ? deepseekSdkCapabilityEvidence(binding, version) : null
    if (executableSha256(binding.path) !== binding.sha256) fail('PROVIDER_IDENTITY_MISMATCH', 'Executable changed while probing')
    return Object.freeze({ ...binding, version, runtimeIdentity: runtimeDependencyIdentity(binding.path, options.env || process.env),
      evidenceHashes: [sha256(versionText), sha256(help), ...(deepseekSdk?.evidenceHashes || [])],
      capabilities: Object.freeze({ cliInterface: true, protocol: d.protocol, conformance: 'NOT_TESTED',
        blockers: [...d.blockers],
        sandbox: 'REQUIRES_CONTROLLER_BOUNDARY',
        exactUsage: 'REQUIRES_NATIVE_REQUEST_EVIDENCE',
        ...(deepseekSdk ? {
          eventStream: 'OWNED_SDK_SESSION_EVENT',
          continuation: 'OWNED_SDK_CORE_RESUME',
          controlledTools: 'OWNED_SDK_FIXED_TOOLS',
          processDrain: 'SDK_SHUTDOWN_AND_SIGNAL_BOUNDED',
        } : {}),
        ...(deepseekSdk ? { deepseekSdk } : {}) }) })
  } finally { fs.rmSync(probeRoot, { recursive: true, force: true }) }
}
function safeString(value, name) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /[\r\n]/.test(value)) fail('PROFILE_INVALID', `Invalid connection field: ${name}`)
  return value
}
function validateEffort(provider, effort) {
  descriptor(provider)
  if (effort === undefined || effort === null) return undefined
  if (provider === 'claude' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if ((provider === 'opencode' || provider === 'kilo') && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if ((provider === 'prime' || provider === 'omp') && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return effort
  if (provider === 'deepseek' && ['off', 'low', 'high', 'max'].includes(effort)) return effort
  if (provider === 'vscode' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) return effort
  fail('PROFILE_INVALID', `${provider} has no verified mapping for reasoning effort ${String(effort)}`)
}
function safeUrl(value, name) {
  const text = safeString(value, name)
  let url
  try { url = new URL(text) } catch { fail('PROFILE_INVALID', `Invalid connection URL: ${name}`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('PROFILE_INVALID', `Invalid connection URL: ${name}`)
  return text
}
function sanitizeConnection(provider, source = {}) {
  const d = descriptor(provider)
  if (provider === 'vscode') return require('./harness-v2-vscode-config.cjs').sanitize(source)
  if (provider === 'prime' || provider === 'omp') return require('./harness-v2-pi-config.cjs').sanitize(provider, source)
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('PROFILE_INVALID', 'Native connection must be an object')
  const result = { provider, environment: {} }
  for (const key of ['model', 'modelProvider']) if (source[key] !== undefined) result[key] = safeString(source[key], key)
  for (const key of d.urls) if (source.environment?.[key] !== undefined) result.environment[key] = safeUrl(source.environment[key], key)
  // OpenCode/Kilo config provider identifiers and the built-in SDK allowlist
  // are data. Arbitrary npm providers execute code and are never imported.
  if (source.providers || source.provider && typeof source.provider === 'object') {
    const providers = source.providers || source.provider
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) fail('PROFILE_INVALID', 'Model providers must be an object')
    result.providers = {}
    for (const [id, value] of Object.entries(providers)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) ||
          !value || typeof value !== 'object' || Array.isArray(value)) fail('PROFILE_INVALID', 'Invalid model provider connection')
      const item = {}
      if (value.npm !== undefined) {
        if (!['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic'].includes(value.npm)) fail('PROFILE_INVALID', 'Custom executable model provider modules are not imported')
        item.npm = value.npm
      }
      item.options = {}
      if (value.options?.baseURL !== undefined) item.options.baseURL = safeUrl(value.options.baseURL, 'baseURL')
      if (value.options?.apiKey !== undefined) item.options.apiKey = safeString(value.options.apiKey, 'apiKey')
      if (value.models) {
        if (typeof value.models !== 'object' || Array.isArray(value.models)) fail('PROFILE_INVALID', 'Model definitions must be an object')
        item.models = {}
        for (const [id, model] of Object.entries(value.models)) {
          safeString(id, 'model id')
          if (['__proto__', 'constructor', 'prototype'].includes(id) || !model || typeof model !== 'object' || Array.isArray(model)) fail('PROFILE_INVALID', 'Invalid model definition')
          item.models[id] = {}
          for (const key of ['name', 'id']) if (typeof model[key] === 'string') item.models[id][key] = safeString(model[key], key)
          if (model.limit) {
            item.models[id].limit = {}
            for (const key of ['context', 'output']) if (Number.isSafeInteger(model.limit[key]) && model.limit[key] > 0) item.models[id].limit[key] = model.limit[key]
          }
          // Model variants are declarative request overlays. Preserve only the
          // reasoning-effort form that the native CLI consumes; profiles cannot
          // inject provider modules, commands, headers, or arbitrary request
          // bodies through this path.
          if (model.variants !== undefined) {
            if (!['opencode', 'kilo'].includes(provider) || !model.variants || typeof model.variants !== 'object' || Array.isArray(model.variants)) fail('PROFILE_INVALID', 'Model variants must be an object')
            item.models[id].variants = {}
            for (const [variantId, variant] of Object.entries(model.variants)) {
              if (!/^[a-zA-Z0-9_-]+$/.test(variantId) || ['__proto__', 'constructor', 'prototype'].includes(variantId) ||
                  !variant || typeof variant !== 'object' || Array.isArray(variant) || typeof variant.reasoningEffort !== 'string') fail('PROFILE_INVALID', 'Invalid model reasoning variant')
              item.models[id].variants[variantId] = { reasoningEffort: safeString(variant.reasoningEffort, 'reasoningEffort') }
            }
          }
        }
      }
      result.providers[id] = item
    }
  }
  return result
}
function connectionConfig(provider, root, env = process.env) {
  const d = descriptor(provider)
  if (provider === 'prime' || provider === 'omp') return require('./harness-v2-pi-config.cjs').readConnection(provider, root)
  const files = provider === 'opencode' || provider === 'kilo' ? [`${provider}.json`, 'config.json'] : ['models.json']
  let source = {}
  for (const name of files) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    try { source = JSON.parse(readBound(file).toString('utf8')) } catch { fail('PROFILE_INVALID', `Native connection config must be valid JSON: ${name}`) }
    break
  }
  const environment = {}
  for (const key of d.urls) if (env[key]) environment[key] = env[key]
  return sanitizeConnection(provider, { ...source, environment })
}
function credentialEnvironment(provider, connection, root, env = process.env) {
  const d = descriptor(provider)
  const result = {}
  // No shell evaluation or OAuth refresh commands. API credentials only.
  let dotenv = ''
  if (root && fs.existsSync(path.join(root, '.env'))) dotenv = readBound(path.join(root, '.env')).toString('utf8')
  const keys = [...d.credentials, ...(['prime', 'omp'].includes(provider) ? require('./harness-v2-pi-config.cjs').credentialNames(connection) : [])]
  for (const key of new Set(keys)) {
    let value = env[key]
    if (!value) {
      const match = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(dotenv)
      if (match) {
        value = match[1].trim()
        if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { fail('PROFILE_INVALID', `Invalid quoted credential: ${key}`) } }
        else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      }
    }
    if (value) result[key] = safeString(value, key)
  }
  return result
}
function declaredVariant(connection, model, effort) {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) fail('PROFILE_INVALID', 'Reasoning effort requires a provider/model reference')
  const providerId = model.slice(0, slash), modelId = model.slice(slash + 1)
  const customModel = connection.providers?.[providerId]?.models?.[modelId]
  // Built-in provider catalogs validate their own variants. A supplied custom
  // provider has no catalog discovery, so require its exact declarative overlay.
  if (!customModel) return
  if (customModel.variants?.[effort]?.reasoningEffort !== effort) fail('PROFILE_INVALID', `Model ${model} has no verified ${effort} reasoning variant`)
}
function createLaunch(options) {
  const { provider, home, sessionRoot, prompt, input, continuationId, readOnly, targetPath } = options
  const d = descriptor(provider)
  if (d.blockers.length) fail('PROVIDER_UNSUPPORTED', `${d.command} cannot satisfy the native transport contract`, { blockers: d.blockers })
  const connection = sanitizeConnection(provider, options.connection)
  const env = isolatedEnvironment(home, options.environment, credentialEnvironment(provider, connection, null, options.credentials || {}))
  Object.assign(env, connection.environment)
  const model = options.model || connection.model
  const controlled = options.toolBoundary ? require('./harness-v2-controlled-tools.cjs') : null
  if (controlled) controlled.load(options.toolBoundary, provider)
  let argv
  if (provider === 'vscode') {
    argv = require('./harness-v2-vscode-config.cjs').project({ ...options, connection }, env)
  } else if (provider === 'claude') {
    const settings = path.join(home, 'settings.json')
    const projection = controlled?.claudeProjection(options.toolBoundary)
    writePrivate(settings, JSON.stringify(projection?.settings || { disableAllHooks: true, enableAllProjectMcpServers: false, permissions: { deny: ['Agent', 'Task', 'Skill', 'mcp__*', ...(readOnly ? ['Write', 'Edit', 'NotebookEdit'] : [])] } }))
    const tools = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Write,Edit'
    // Bash is offered only behind an authenticated controller execution gate.
    const offered = controlled ? '' : options.commandBoundary ? `${tools},Bash` : tools
    argv = ['--print', '--bare', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(projection?.mcp || { mcpServers: {} }), '--tools', offered, '--allowedTools', projection?.allowedTools || offered, '--permission-mode', 'dontAsk', '--system-prompt', prompt]
    const effort = validateEffort(provider, options.effort)
    if (effort) argv.push('--effort', effort)
    if (continuationId) argv.push('--resume', continuationId)
    env.CLAUDE_CONFIG_DIR = path.join(sessionRoot, 'claude')
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  } else if (provider === 'opencode' || provider === 'kilo') {
    const tools = { read: true, glob: true, grep: true, list: true, write: !readOnly, edit: !readOnly, patch: !readOnly, bash: Boolean(options.commandBoundary) }
    const projection = controlled?.opencodeProjection(options.toolBoundary, provider)
    const permission = projection?.permission || { '*': 'deny', ...Object.fromEntries(Object.entries(tools).filter(([, enabled]) => enabled).map(([name]) => [name, 'allow'])), external_directory: { '*': 'deny', [`${targetPath}/**`]: 'allow' } }
    // Native title/summary requests are not part of the run event ledger.
    // Disable them instead of silently omitting their model usage. Use one
    // permission table; deprecated `tools` overrides can reorder its rules.
    const disabledAgents = Object.fromEntries(['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction'].map(name => [name, { disable: true }]))
    const config = { ...(connection.model ? { model: connection.model } : {}), ...(connection.providers ? { provider: connection.providers } : {}), share: 'disabled', autoupdate: false, plugin: [], mcp: projection?.mcp || {}, instructions: [], lsp: false, formatter: false, compaction: { auto: false, prune: false }, permission, agent: { ...disabledAgents, autoprompt: { mode: 'primary', prompt, permission } } }
    const file = path.join(home, `${provider}.json`)
    writePrivate(file, JSON.stringify(config))
    const prefix = provider.toUpperCase()
    env[`${prefix}_CONFIG`] = file
    env[`${prefix}_CONFIG_DIR`] = path.join(home, 'native-config')
    env[`${prefix}_DISABLE_PROJECT_CONFIG`] = 'true'
    // State survives exact continuation, config remains dispatch-specific.
    env.XDG_DATA_HOME = path.join(sessionRoot, 'data')
    env.XDG_STATE_HOME = path.join(sessionRoot, 'state')
    argv = ['run', '--format', 'json', '--agent', 'autoprompt']
    const effort = validateEffort(provider, options.effort)
    if (effort) {
      declaredVariant(connection, model, effort)
      argv.push('--variant', effort)
    }
    if (continuationId) argv.push('--session', continuationId)
  } else if (provider === 'deepseek') {
    if (!controlled || !options.executable) fail('PROVIDER_UNSUPPORTED', 'DeepSeek requires its bound official SDK and owned tool projection')
    const effort = validateEffort(provider, options.effort)
    const packageRoot = path.dirname(deepseekPackageRoot(options.executable))
    const file = path.join(home, 'owned.patch.json')
    const sessionId = continuationId || crypto.randomUUID()
    writePrivate(file, JSON.stringify([
      ...['sdk-app-startup', 'sdk-jsonrpc-server', 'persistent-bash', 'persistent-pwsh', 'str-replace-editor', 'llm-retry'].map(id => ({ id, disabled: true })),
      { insert: [{ id: 'autoprompt-owned-sdk', name: require.resolve('./harness-v2-bridge/deepseek/plugin.cjs'), config: {
        packageRoot, oneShot: true, sessionId, input,
        initialize: { cwd: options.cwd, provider: connection.modelProvider || 'deepseek-official', model: model || 'deepseek-chat', ...(effort ? { reasoningEffort: effort } : {}), ...(continuationId ? { resumeSessionId: continuationId } : {}) },
      } }] },
    ]))
    env.DSH_HOME = path.join(sessionRoot, 'dsh')
    env.DSH_SYSTEM_PROMPT = prompt
    env.DSH_TELEMETRY_DISABLED = '1'
    env.AUTOPROMPT_TOOL_POLICY = options.toolBoundary.policyPath
    env.AUTOPROMPT_TOOL_POLICY_SHA256 = options.toolBoundary.policySha256
    argv = ['--profile', 'sdk-minimal', '--patch', file]
  } else if (controlled) {
    const effort = validateEffort(provider, options.effort)
    argv = require('./harness-v2-pi-config.cjs').project({ ...options, connection, effort }, env)
  } else {
    argv = ['--print', '--mode', 'json', '--no-extensions', '--no-skills', '--system-prompt', prompt, '--session-dir', path.join(sessionRoot, 'sessions')]
    if (provider === 'prime') {
      // IPython includes the rlm child-spawn API. Never expose it merely because
      // an outer filesystem sandbox is available.
      argv.push('--no-tools', '--no-context-files', '--no-prompt-templates', '--offline')
      env.PRIME_AGENT_CODING_AGENT_DIR = path.join(home, 'prime')
    } else {
      argv.push('--no-rules', '--no-lsp', '--no-pty', '--tools', `${readOnly ? 'read,grep,find,ls' : 'read,grep,find,ls,write,edit'}${options.commandBoundary ? ',bash' : ''}`)
      env.PI_CODING_AGENT_DIR = path.join(home, 'omp')
    }
    if (continuationId) argv.push('--resume', continuationId)
    if (connection.modelProvider) argv.push('--provider', connection.modelProvider)
  }
  if (model && !['deepseek', 'vscode'].includes(provider)) argv.push('--model', safeString(model, 'model'))
  return { argv, env, stdin: input, cwd: options.cwd, shell: false }
}
module.exports = { runtimeDependencyIdentity, validateEffort, PROVIDERS, HarnessError, fail, descriptor, locateExecutable, executableSha256, probeExecutable, deepseekSdkCapabilityEvidence, connectionConfig, sanitizeConnection, credentialEnvironment, isolatedEnvironment, createLaunch, readBound, sha256, privateDirectory, writePrivate }
