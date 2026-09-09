#!/usr/bin/env node
'use strict'

// The guest owns the entire controller lifecycle. Transport success is never
// interpreted as a terminal mission result or a process-drain receipt.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const GUEST_ROOT = '/home/autoprompt/runtime'
const TARGET_RECORD = `${GUEST_ROOT}/target.json`
const PROVIDER_CONFIG = `${GUEST_ROOT}/provider-config.json`
const PINNED_NODE_ROOT = `${GUEST_ROOT}/pinned/toolchain/node-v22.23.2-linux-${process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'unsupported'}`
const PROVIDER_CONNECTION_RULES = Object.freeze({
  claude: { keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], endpointEnv: 'ANTHROPIC_BASE_URL' }, codex: { keys: ['OPENAI_API_KEY'], endpointEnv: 'OPENAI_BASE_URL' },
  opencode: { keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null }, kilo: { keys: ['KILO_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null },
  vscode: { keys: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], endpointEnv: null }, prime: { keys: ['PRIME_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null },
  omp: { keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null }, deepseek: { keys: ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: 'DEEPSEEK_BASE_URL' },
  hermes: { keys: ['HERMES_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: 'HERMES_BASE_URL' }, grok: { keys: ['GROK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'], endpointEnv: 'GROK_BASE_URL' }, reasonix: { keys: [], endpointEnv: null },
})
const PROVIDER_CONNECTION_FILES = Object.freeze({
  claude: 'models.json', codex: 'connection.json', opencode: 'opencode.json', kilo: 'kilo.json', vscode: 'models.json',
  prime: 'models.json', omp: 'models.json', deepseek: 'models.json', hermes: 'models.json', grok: 'models.json', reasonix: 'config.toml',
})
const FORBIDDEN_CREDENTIAL_NAMES = new Set(['BASH_ENV', 'CDPATH', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_prefix', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'SHELLOPTS'])
function targetPath() {
  const item = fs.lstatSync(TARGET_RECORD, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', 'Target mapping is not private')
  const value = JSON.parse(fs.readFileSync(TARGET_RECORD, 'utf8'))
  if (Object.keys(value).join(',') !== 'target' || typeof value.target !== 'string' || !path.isAbsolute(value.target) || path.normalize(value.target) !== value.target || /[\u0000-\u001f\u007f]/.test(value.target)) fail('LIMA_GUEST_UNSAFE', 'Target mapping is invalid')
  return value.target
}
const MAX_REQUEST = 1024 * 1024
function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function parseRequest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_REQUEST) fail('LIMA_REQUEST_INVALID', 'Request exceeds the transport bound')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('LIMA_REQUEST_INVALID', 'Request is invalid JSON') }
  if (!value || value.schemaVersion !== 1 || !['setup', 'status', 'exec', 'cancel'].includes(value.action) ||
      Object.keys(value).some(key => !['schemaVersion', 'action', 'archiveSha256', 'argv', 'requestId'].includes(key))) fail('LIMA_REQUEST_INVALID', 'Unknown request fields or action')
  if (value.action === 'setup') {
    if (!/^[a-f0-9]{64}$/.test(value.archiveSha256 || '') || value.argv !== undefined || value.requestId !== undefined) fail('LIMA_REQUEST_INVALID', 'Setup requires an exact archive digest')
  } else if (value.archiveSha256 !== undefined || ((value.action === 'status' || value.action === 'cancel') && value.argv !== undefined)) fail('LIMA_REQUEST_INVALID', 'Unexpected request fields')
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(value.requestId))) fail('LIMA_REQUEST_INVALID', 'Request ID must contain exactly 32 lowercase hexadecimal characters')
  if (['exec', 'cancel'].includes(value.action) && value.requestId === undefined) fail('LIMA_REQUEST_INVALID', 'Execution requires an exact request ID')
  if (value.action === 'exec' && (!Array.isArray(value.argv) || value.argv.length > 128 || value.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')))) fail('LIMA_REQUEST_INVALID', 'Invalid command arguments')
  return value
}
function privateJson(file, label) {
  const item = fs.lstatSync(file, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o077n) !== 0n) fail('LIMA_GUEST_UNSAFE', `${label} is not private`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('LIMA_GUEST_UNSAFE', `${label} is invalid JSON`) }
}
function providerConfiguration() {
  const value = privateJson(PROVIDER_CONFIG, 'Guest provider configuration')
  if (!value || value.schemaVersion !== 2 || value.kind !== 'lima-guest-provider-config-v1' ||
      typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.provider) ||
      typeof value.endpoint !== 'string' || typeof value.target !== 'string' || !/^[a-f0-9]{64}$/.test(value.credentialSha256 || '') || !/^[a-f0-9]{64}$/.test(value.connectionSha256 || '') || !/^[a-f0-9]{64}$/.test(value.connectionIdentitySha256 || '') || typeof value.connectionName !== 'string' || !/^[a-f0-9]{64}$/.test(value.nativeSha256 || '') || !/^[a-f0-9]{64}$/.test(value.toolchainSha256 || '') ||
      !PROVIDER_CONNECTION_FILES[value.provider] || value.connectionName !== PROVIDER_CONNECTION_FILES[value.provider] ||
      (value.hostBackend !== undefined && value.hostBackend !== 'wsl2-drvfs') || (value.hostBackend === 'wsl2-drvfs' && !/^[a-f0-9]{64}$/.test(value.hostTargetSha256 || '')) ||
      Object.keys(value).some(key => !['schemaVersion','kind','provider','endpoint','target','credentialSha256','connectionSha256','connectionIdentitySha256','connectionName','nativeSha256','toolchainSha256','modelSelectionSha256','hostBackend','hostTargetSha256'].includes(key)) || value.target !== targetPath()) {
    fail('LIMA_GUEST_UNSAFE', 'Guest provider configuration is not bound to this provider and target')
  }
  let endpoint
  try { endpoint = new URL(value.endpoint) } catch { fail('LIMA_GUEST_UNSAFE', 'Guest provider endpoint is invalid') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('LIMA_GUEST_UNSAFE', 'Guest provider endpoint is unsafe')
  const providerRoot = path.join(GUEST_ROOT, 'providers', value.provider)
  const connection = path.join(providerRoot, value.connectionName)
  const credentialFile = path.join(providerRoot, 'credentials.json')
  const credential = privateJson(credentialFile, 'Guest provider credential')
  const connectionBytes = fs.readFileSync(connection)
  if (crypto.createHash('sha256').update(connectionBytes).digest('hex') !== value.connectionSha256) fail('LIMA_GUEST_UNSAFE', 'Guest native connection binding changed')
  const credentialBytes = fs.readFileSync(credentialFile)
  if (crypto.createHash('sha256').update(credentialBytes).digest('hex') !== value.credentialSha256) fail('LIMA_GUEST_UNSAFE', 'Guest provider credential binding changed')
  const rule = PROVIDER_CONNECTION_RULES[value.provider]
  const entries = credential && credential.environment && typeof credential.environment === 'object' && !Array.isArray(credential.environment) ? Object.entries(credential.environment) : []
  let allowedKeys = rule?.keys || []
  const installedRoot = path.join(GUEST_ROOT, 'install', 'node_modules', 'autoprompt-skill')
  if (fs.existsSync(installedRoot)) {
    try {
      if (value.provider === 'reasonix') allowedKeys = [...new Set(require(path.join(installedRoot, 'agents', 'reasonix', 'workflow', 'native.js')).connectionConfig(connection).providers.map(item => item.api_key_env).filter(Boolean))]
      else if (['prime', 'omp'].includes(value.provider)) allowedKeys = require(path.join(installedRoot, 'scripts', 'harness-v2-pi-config.cjs')).credentialNames(require(path.join(installedRoot, 'scripts', 'harness-v2-native.cjs')).connectionConfig(value.provider, providerRoot))
    } catch (error) { fail('LIMA_GUEST_UNSAFE', `Guest native connection cannot be verified: ${error.message}`) }
  } else if (value.provider === 'reasonix' || ['prime', 'omp'].includes(value.provider)) {
    // These names are data in their native connection file.  They are checked
    // against the installed package before any command can run.
    allowedKeys = entries.map(([name]) => name)
  }
  if (!credential || credential.schemaVersion !== 1 || credential.provider !== value.provider || !rule || !entries.length ||
      !entries.every(([name, secret]) => !FORBIDDEN_CREDENTIAL_NAMES.has(name) && allowedKeys.includes(name) && typeof secret === 'string' && secret.length > 0 && secret.length <= 16384)) {
    fail('LIMA_GUEST_UNSAFE', 'Guest provider credential is invalid')
  }
  if (value.modelSelectionSha256) {
    const modelSelection = path.join(providerRoot, `.autoprompt-${value.provider}-models.json`)
    if (crypto.createHash('sha256').update(fs.readFileSync(modelSelection)).digest('hex') !== value.modelSelectionSha256) fail('LIMA_GUEST_UNSAFE', 'Guest model selection binding changed')
  }
  return { provider: value.provider, endpoint: endpoint.toString().replace(/\/$/u, ''), target: value.target, environment: credential.environment, credentialSha256: value.credentialSha256, connectionSha256: value.connectionSha256, connectionIdentitySha256: value.connectionIdentitySha256, nativeSha256: value.nativeSha256, toolchainSha256: value.toolchainSha256, ...(value.hostBackend ? { hostBackend: value.hostBackend, hostTargetSha256: value.hostTargetSha256 } : {}) }
}
function materializeProviderConnection(config) {
  if (config.provider !== 'codex') return
  const key = config.environment.OPENAI_API_KEY
  if (typeof key !== 'string' || !key) fail('LIMA_GUEST_UNSAFE', 'Configured Codex connection lacks OPENAI_API_KEY')
  const auth = path.join(GUEST_ROOT, 'providers', 'codex', 'auth.json')
  const content = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key })
  if (fs.existsSync(auth)) {
    const existing = privateJson(auth, 'Guest Codex auth record')
    if (existing.auth_mode !== 'apikey' || existing.OPENAI_API_KEY !== key || Object.keys(existing).sort().join(',') !== 'OPENAI_API_KEY,auth_mode') fail('LIMA_GUEST_UNSAFE', 'Guest Codex auth record does not match the configured connection')
  } else fs.writeFileSync(auth, content, { mode: 0o600, flag: 'wx' })
}
function providerRuntimeEnvironment() {
  const config = providerConfiguration()
  materializeProviderConnection(config)
  const rule = PROVIDER_CONNECTION_RULES[config.provider]
  const ownedVscodeDisplay = config.provider === 'vscode' && typeof process.env.DISPLAY === 'string' && /^:[0-9]+$/.test(process.env.DISPLAY) &&
    typeof process.env.XAUTHORITY === 'string' && process.env.XAUTHORITY.startsWith(`${GUEST_ROOT}/displays/`) &&
    typeof process.env.XDG_RUNTIME_DIR === 'string' && process.env.XDG_RUNTIME_DIR.startsWith(`${GUEST_ROOT}/d/`)
    ? { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
    : {}
  return { ...pinnedRuntimeEnvironment(), ...config.environment, ...ownedVscodeDisplay, PATH: `${GUEST_ROOT}/native/${config.provider}/bin:${GUEST_ROOT}/native/${config.provider}/node_modules/.bin:${GUEST_ROOT}/native/${config.provider}:${PINNED_NODE_ROOT}/bin:/usr/local/bin:/usr/bin:/bin`, ...(rule.endpointEnv ? { [rule.endpointEnv]: config.endpoint } : {}) }
}
function commandArgv(argv, cli, configuration = providerConfiguration()) {
  const parsed = cli.parseArgs(argv)
  if (parsed.command === 'admission') fail('LIMA_COMMAND_UNSUPPORTED', 'Admission does not run through the VM bridge')
  if (parsed.command === 'activate' && parsed.provider !== configuration.provider) fail('LIMA_PROVIDER_CONFIG_INVALID', 'Activation provider does not match the configured guest provider')
  if (!['install', 'doctor', 'configure', 'uninstall', 'activate', 'version', 'conformance'].includes(parsed.command)) fail('LIMA_COMMAND_UNSUPPORTED', 'Command is not supported by the guest bridge')
  if (parsed.root || parsed.vmRoot || parsed.wslRoot || parsed.target || parsed.modelMap || parsed.output || parsed.integrationTests || parsed.nativeTests) fail('LIMA_REQUEST_INVALID', 'Host paths and unrestricted diagnostic options cannot cross the guest bridge')
  if (parsed.command === 'uninstall' && parsed.client !== configuration.provider) {
    fail('LIMA_PROVIDER_CONFIG_INVALID', 'Uninstall must name the one configured guest provider')
  }
  if (['install', 'doctor'].includes(parsed.command) && (!parsed.client || parsed.client === 'all')) fail('LIMA_COMMAND_UNSUPPORTED', 'Install one provider at a time')
  const injected = ['install', 'doctor', 'configure', 'uninstall'].includes(parsed.command)
    ? ['--root', `${GUEST_ROOT}/providers/${parsed.provider || parsed.client || 'codex'}`]
    : parsed.command === 'activate'
      ? ['--root', `${GUEST_ROOT}/providers/${configuration.provider}`, '--target', configuration.target]
      : []
  // Activation syntax places mission arguments after `--`.  Any future
  // controller-owned root/target flags must remain in the command portion;
  // appending them would silently turn them into mission text.
  const delimiter = argv.indexOf('--')
  return delimiter < 0 ? [...argv, ...injected] : [
    ...argv.slice(0, delimiter), ...injected, ...argv.slice(delimiter),
  ]
}
function privateExecutable(file, label) {
  const item = fs.lstatSync(file, { bigint: true })
  const resolved = fs.realpathSync(file)
  const resolvedItem = fs.lstatSync(resolved, { bigint: true })
  if ((!item.isFile() && !item.isSymbolicLink()) || !resolvedItem.isFile() ||
      (resolvedItem.mode & 0o022n) !== 0n || !resolved.startsWith(`${PINNED_NODE_ROOT}/`)) {
    fail('LIMA_GUEST_UNSAFE', `${label} is not a private pinned runtime executable`)
  }
  try { fs.accessSync(file, fs.constants.X_OK) } catch { fail('LIMA_GUEST_UNSAFE', `${label} is not executable`) }
  return file
}
function pinnedNpm() {
  return privateExecutable(path.join(PINNED_NODE_ROOT, 'bin', 'npm'), 'Pinned npm')
}
function pinnedRuntimeEnvironment() {
  const bin = path.join(PINNED_NODE_ROOT, 'bin')
  privateExecutable(path.join(bin, 'node'), 'Pinned Node')
  return { HOME: '/home/autoprompt', PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }
}
function physicalDirectory(file) {
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) fail('LIMA_GUEST_UNSAFE', 'Guest directory must have a physical path')
  return stat
}
function packageDigest(root) {
  physicalDirectory(root)
  const digest = crypto.createHash('sha256'); let count = 0
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), item = fs.lstatSync(file, { bigint: true })
      if (++count > 100000) fail('LIMA_PACKAGE_CHANGED', 'Installed package entry bound exceeded')
      digest.update(JSON.stringify([path.relative(root, file), Number(item.mode)]))
      if (item.isDirectory()) visit(file)
      else if (item.isFile() && item.nlink === 1n) digest.update(fs.readFileSync(file))
      else if (item.isSymbolicLink() && fs.realpathSync(file).startsWith(root + '/')) digest.update(fs.readlinkSync(file))
      else fail('LIMA_PACKAGE_CHANGED', 'Installed package has an unsafe entry')
    }
  }
  visit(root); return digest.digest('hex')
}
function portableTreeDigest(root) {
  const items = []; let count = 0
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true }), relative = path.relative(root, file)
      if (++count > 100000) fail('LIMA_GUEST_UNSAFE', 'Imported runtime entry limit exceeded')
      if (stat.isDirectory()) { items.push({ path: relative, type: 'directory', mode: Number(stat.mode) }); visit(file) }
      else if (stat.isFile() && stat.nlink === 1n) items.push({ path: relative, type: 'file', mode: Number(stat.mode), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })
      else if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(file)
        if (!resolved.startsWith(root + '/')) fail('LIMA_GUEST_UNSAFE', 'Imported runtime symlink escapes its root')
        // Link modes are transport/platform metadata (not stable across a
        // macOS host and Linux guest).  The host portable digest binds the
        // same path/type/target tuple.
        items.push({ path: relative, type: 'link', target: fs.readlinkSync(file) })
      } else fail('LIMA_GUEST_UNSAFE', 'Imported runtime contains an unsafe entry')
    }
  }
  visit(root)
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex')
}
function verifyImportedClosures(configuration) {
  const toolchain = PINNED_NODE_ROOT, native = path.join(GUEST_ROOT, 'native', configuration.provider)
  if (portableTreeDigest(toolchain) !== configuration.toolchainSha256 || portableTreeDigest(native) !== configuration.nativeSha256) fail('LIMA_GUEST_UNSAFE', 'Transferred runtime closure digest differs from the configured import')
  const node = privateExecutable(path.join(toolchain, 'bin', 'node'), 'Pinned Node')
  const version = childProcess.spawnSync(node, ['--version'], { shell: false, encoding: 'utf8', timeout: 15000, env: pinnedRuntimeEnvironment() })
  if (version.error || version.status !== 0 || !/^v22\.23\.2\s*$/m.test(version.stdout || '')) fail('LIMA_TOOLCHAIN_INVALID', 'Transferred Node toolchain is not the required executable Linux v22.23.2 runtime')
  const nativeRoot = path.join(GUEST_ROOT, 'native', configuration.provider)
  const command = configuration.provider === 'codex' ? 'codex' : configuration.provider === 'reasonix' ? 'reasonix' :
    require(path.join(GUEST_ROOT, 'install', 'node_modules', 'autoprompt-skill', 'scripts', 'harness-v2-native.cjs')).descriptor(configuration.provider).command
  const executable = [path.join(nativeRoot, 'bin', command), path.join(nativeRoot, command), path.join(nativeRoot, 'node_modules', '.bin', command)].find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate).startsWith(nativeRoot + '/') && fs.statSync(candidate).isFile() } catch { return false }
  })
  if (!executable || !fs.realpathSync(executable).startsWith(nativeRoot + '/')) fail('LIMA_NATIVE_IMPORT_INVALID', 'Imported provider closure has no private executable at its declared native path')
  const probe = childProcess.spawnSync(executable, ['--version'], { shell: false, encoding: 'utf8', timeout: 30000, env: providerRuntimeEnvironment() })
  if (probe.error || probe.status !== 0 || !String(probe.stdout || probe.stderr || '').trim()) fail('LIMA_NATIVE_IMPORT_INVALID', 'Imported provider executable cannot run from the guest-native closure')
}
function verifyNativeConnection(configuration) {
  const packageRoot = path.join(GUEST_ROOT, 'install', 'node_modules', 'autoprompt-skill')
  const root = path.join(GUEST_ROOT, 'providers', configuration.provider)
  const file = path.join(root, PROVIDER_CONNECTION_FILES[configuration.provider])
  let parsed
  if (configuration.provider === 'reasonix') parsed = require(path.join(packageRoot, 'agents', 'reasonix', 'workflow', 'native.js')).connectionConfig(file)
  else if (configuration.provider === 'codex') parsed = privateJson(file, 'Guest Codex native connection')
  else {
    const rule = PROVIDER_CONNECTION_RULES[configuration.provider]
    parsed = require(path.join(packageRoot, 'scripts', 'harness-v2-native.cjs')).connectionConfig(configuration.provider, root, rule.endpointEnv ? { [rule.endpointEnv]: configuration.endpoint } : {})
  }
  const binds = ['opencode', 'kilo'].includes(configuration.provider)
    ? Object.values(parsed.providers || {}).some(item => item?.options?.baseURL === configuration.endpoint)
    : configuration.provider === 'vscode' ? parsed.baseUrl === configuration.endpoint
      : ['prime', 'omp'].includes(configuration.provider) ? Object.values(parsed.providers || {}).some(item => item?.baseUrl === configuration.endpoint || item?.models?.some(model => model?.baseUrl === configuration.endpoint))
        : configuration.provider === 'reasonix' ? (parsed.providers || []).some(item => ['base_url', 'chat_url', 'request_url'].some(key => item?.[key] === configuration.endpoint)) : true
  const identity = crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
  if (!PROVIDER_CONNECTION_RULES[configuration.provider].endpointEnv && !binds) fail('LIMA_GUEST_UNSAFE', 'Guest native connection no longer binds the configured endpoint through its reviewed provider route')
  if (identity !== configuration.connectionIdentitySha256) fail('LIMA_GUEST_UNSAFE', 'Guest native connection identity differs from the configured import')
}
function mountRecord(lines, target) {
  const decodeMount = value => value?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
  const mount = lines.find(line => decodeMount(line.split(' ')[4]) === target)
  const left = mount?.split(' - ')[0]?.split(' ') || [], right = mount?.split(' - ')[1]?.split(' ') || []
  return { type: right[0], source: decodeMount(right[1]), mountOptions: new Set(String(left[5] || '').split(',')), superOptions: String(right.slice(2).join(' ')) }
}
function status() {
  if (process.platform !== 'linux') fail('LIMA_GUEST_PLATFORM', 'The guest controller requires Linux')
  const TARGET = targetPath()
  const root = physicalDirectory(GUEST_ROOT), target = physicalDirectory(TARGET)
  if (root.dev === target.dev) fail('LIMA_GUEST_UNSAFE', 'Controller storage must be separate from the host target export')
  const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
  const { type, source, mountOptions, superOptions } = mountRecord(lines, TARGET)
  const configuration = providerConfiguration()
  const allowedMounts = configuration.hostBackend === 'wsl2-drvfs' ? ['9p', 'drvfs'] : ['9p', 'virtiofs']
  if (!allowedMounts.includes(type)) fail('LIMA_GUEST_UNSAFE', `The exact target export must use the configured ${configuration.hostBackend === 'wsl2-drvfs' ? 'WSL drvfs' : 'Lima shared-filesystem'} backend`)
  if (configuration.hostBackend === 'wsl2-drvfs' && (!mountOptions.has('rw') || !['metadata','uid=1000','gid=1000','umask=077','fmask=077'].every(option => superOptions.includes(option)) || crypto.createHash('sha256').update(String(source || '').toLowerCase()).digest('hex') !== configuration.hostTargetSha256)) fail('LIMA_GUEST_UNSAFE', 'The WSL target mount source, writable mode, or private metadata options differ from the configured host export')
  return { schemaVersion: 1, status: 'CONFIGURED', platform: process.platform, arch: process.arch,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    target: { path: TARGET, dev: String(target.dev), ino: String(target.ino), mountType: type },
    privateRoot: { path: GUEST_ROOT, dev: String(root.dev), ino: String(root.ino) }, provider: { id: configuration.provider, endpoint: configuration.endpoint, credentialSha256: configuration.credentialSha256 } }
}
function run(request) {
  const snapshot = status()
  if (request.action === 'status') return snapshot
  const packageRoot = path.join(GUEST_ROOT, 'install', 'node_modules', 'autoprompt-skill')
  if (request.action === 'setup') {
    const archive = path.join(GUEST_ROOT, 'package.tgz')
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    if (digest !== request.archiveSha256) fail('LIMA_PACKAGE_CHANGED', 'The transferred package archive changed')
    const savedBinding = path.join(GUEST_ROOT, 'package-binding.json')
    if (fs.existsSync(savedBinding)) {
      const saved = JSON.parse(fs.readFileSync(savedBinding, 'utf8'))
      if (saved.schemaVersion !== 1 || saved.archiveSha256 !== digest || saved.packageTreeSha256 !== packageDigest(packageRoot)) fail('LIMA_PACKAGE_CHANGED', 'Resume package differs from the original setup')
      return { ...snapshot, packageSha256: digest }
    }
    // The exact archive carries bundled dependencies. An empty offline cache
    // prevents a guest install from resolving a different dependency version.
    const cache = path.join(GUEST_ROOT, 'npm-cache')
    if (!fs.existsSync(cache)) fs.mkdirSync(cache, { mode: 0o700 })
    const npm = childProcess.spawnSync(pinnedNpm(), ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--prefix', path.join(GUEST_ROOT, 'install'), archive], { shell: false, stdio: 'inherit', env: pinnedRuntimeEnvironment() })
    if (npm.error || npm.status !== 0) fail('LIMA_PACKAGE_INSTALL_FAILED', 'Offline guest package installation failed')
    const configuration = providerConfiguration(); verifyNativeConnection(configuration); verifyImportedClosures(configuration)
    fs.writeFileSync(path.join(GUEST_ROOT, 'package-binding.json'), JSON.stringify({ schemaVersion: 1, archiveSha256: digest, packageTreeSha256: packageDigest(packageRoot) }) + '\n', { flag: 'wx', mode: 0o600 })
    return { ...snapshot, packageSha256: digest }
  }
  const installed = JSON.parse(fs.readFileSync(path.join(GUEST_ROOT, 'package-binding.json'), 'utf8'))
  if (installed.schemaVersion !== 1 || installed.packageTreeSha256 !== packageDigest(packageRoot)) fail('LIMA_PACKAGE_CHANGED', 'Installed guest runtime changed from setup')
  const configuration = providerConfiguration(); verifyNativeConnection(configuration); verifyImportedClosures(configuration)
  const cli = require(path.join(packageRoot, 'bin', 'autoprompt.cjs'))
  const argv = commandArgv(request.argv, cli)
  return cli.run(argv, { cwd: targetPath(), interactive: false, env: providerRuntimeEnvironment() })
}
function lifecycleSocket() { return path.join(GUEST_ROOT, 'lifecycle.sock') }
function lifecycleFrame(frame) {
  return new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(lifecycleSocket())
    let bytes = 0, output = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify(frame)}\n`))
    socket.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > MAX_REQUEST) socket.destroy(Object.assign(new Error('Lifecycle response too large'), { code: 'LIMA_GUEST_FAILED' })); else output += chunk })
    socket.once('error', reject)
    socket.once('end', () => {
      try {
        const value = JSON.parse(output.trim())
        if (value.type === 'error') return reject(Object.assign(new Error(value.message), { code: value.code }))
        resolve(value)
      } catch { reject(Object.assign(new Error('Lifecycle response is invalid'), { code: 'LIMA_GUEST_FAILED' })) }
    })
  })
}
async function ensureLifecycle() {
  try { await lifecycleFrame({ op: 'ping' }); return } catch { /* start below */ }
  const lifecycle = path.join(GUEST_ROOT, 'lima-runtime-guest-lifecycle.cjs')
  const item = fs.lstatSync(lifecycle, { bigint: true })
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1n || (item.mode & 0o022n) !== 0n) fail('LIMA_GUEST_UNSAFE', 'Guest lifecycle controller is unsafe')
  const child = childProcess.spawn(path.join(PINNED_NODE_ROOT, 'bin', 'node'), [lifecycle, '--serve'], {
    detached: true, stdio: 'ignore', env: pinnedRuntimeEnvironment(),
  })
  child.unref()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    try { await lifecycleFrame({ op: 'ping' }); return } catch { /* still starting */ }
  }
  fail('LIMA_LIFECYCLE_UNAVAILABLE', 'Guest lifecycle controller did not become available')
}
function lifecycleExec(request) {
  return new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(lifecycleSocket())
    let bytes = 0, output = '', cancelling = false
    const cancel = reason => {
      if (cancelling || socket.destroyed) return
      cancelling = true
      socket.write(`${JSON.stringify({ op: 'cancel', requestId: request.requestId, reason })}\n`)
    }
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'start', requestId: request.requestId, argv: request.argv })}\n`))
    socket.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > MAX_REQUEST) socket.destroy(Object.assign(new Error('Lifecycle response too large'), { code: 'LIMA_GUEST_FAILED' })); else output += chunk })
    socket.once('error', reject)
    socket.once('end', () => {
      try {
        const value = JSON.parse(output.trim())
        if (value.type === 'error') return reject(Object.assign(new Error(value.message), { code: value.code }))
        resolve(value)
      } catch { reject(Object.assign(new Error('Lifecycle response is invalid'), { code: 'LIMA_GUEST_FAILED' })) }
    })
    process.stdin.once('end', () => cancel('BRIDGE_EOF'))
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => cancel(`BRIDGE_${signal}`))
  })
}
async function bridge(request) {
  if (request.action === 'setup') return run(request)
  if (request.action === 'status' && request.requestId === undefined) return status()
  await ensureLifecycle()
  if (request.action === 'status') return (await lifecycleFrame({ op: 'status', requestId: request.requestId })).record
  if (request.action === 'cancel') return (await lifecycleFrame({ op: 'cancel', requestId: request.requestId })).record
  return lifecycleExec(request)
}
if (require.main === module) {
  let source = '', handled = false
  const done = async request => {
    try {
      const result = await bridge(request)
      // The host deliberately keeps its write side open until it has a
      // durable receipt.  Once that receipt is flushed, this bridge must stop
      // watching stdin or `limactl shell` can remain open forever.
      process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0))
    } catch (error) {
      process.stderr.write(`${error.code || 'LIMA_GUEST_FAILED'}: ${error.message}\n`, () => process.exit(2))
    }
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    if (handled) return
    source += chunk
    if (Buffer.byteLength(source) > MAX_REQUEST) { process.stderr.write('LIMA_REQUEST_INVALID: request too large\n'); process.exit(2) }
    const newline = source.indexOf('\n')
    if (newline < 0) return
    handled = true
    if (source.slice(newline + 1).trim()) { process.stderr.write('LIMA_REQUEST_INVALID: request must be one line\n'); process.exitCode = 2; return }
    done(parseRequest(Buffer.from(source.slice(0, newline))))
  })
  process.stdin.on('end', () => {
    if (!handled) { process.stderr.write('LIMA_REQUEST_INVALID: request ended before a complete line\n'); process.exitCode = 2 }
  })
}
module.exports = { parseRequest, commandArgv, run, status, bridge, lifecycleFrame, lifecycleExec, ensureLifecycle, GUEST_ROOT, targetPath, providerConfiguration, materializeProviderConnection, providerRuntimeEnvironment, packageDigest, portableTreeDigest, mountRecord, pinnedNpm, pinnedRuntimeEnvironment, MAX_REQUEST }
