#!/usr/bin/env node
'use strict'

// Explicit Linux VM backend. Setup prepares a guest; it does not manufacture
// native harness or shared-filesystem conformance evidence.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const { parseRequest, GUEST_ROOT } = require('./lima-runtime-guest.cjs')
const VERSION = '2.2.0'
const PUBLIC_PROVIDERS = new Set(['claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok', 'reasonix'])
const PROVIDER_CONNECTION_RULES = Object.freeze({
  claude: { keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'], endpointEnv: 'ANTHROPIC_BASE_URL' },
  codex: { keys: ['OPENAI_API_KEY'], endpointEnv: 'OPENAI_BASE_URL' },
  opencode: { keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null },
  kilo: { keys: ['KILO_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null },
  vscode: { keys: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], endpointEnv: null },
  prime: { keys: ['PRIME_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null },
  omp: { keys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: null },
  deepseek: { keys: ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: 'DEEPSEEK_BASE_URL' },
  hermes: { keys: ['HERMES_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'], endpointEnv: 'HERMES_BASE_URL' },
  grok: { keys: ['GROK_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'], endpointEnv: 'GROK_BASE_URL' },
  reasonix: { keys: [], endpointEnv: null },
})
const PROVIDER_CONNECTION_FILES = Object.freeze({
  claude: 'models.json', codex: 'connection.json', opencode: 'opencode.json', kilo: 'kilo.json', vscode: 'models.json',
  prime: 'models.json', omp: 'models.json', deepseek: 'models.json', hermes: 'models.json', grok: 'models.json', reasonix: 'config.toml',
})
const FORBIDDEN_CREDENTIAL_NAMES = new Set(['BASH_ENV', 'CDPATH', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'npm_config_prefix', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'SHELLOPTS'])
const IMAGES = Object.freeze({
  x86_64: { location: 'https://cloud-images.ubuntu.com/releases/resolute/release-20260720/ubuntu-26.04-server-cloudimg-amd64.img', digest: 'sha256:117816726abbdefc5ef3e38902e81a76f1c76c3610e709999d0885f9d5d9b477' },
  aarch64: { location: 'https://cloud-images.ubuntu.com/releases/resolute/release-20260720/ubuntu-26.04-server-cloudimg-arm64.img', digest: 'sha256:7bcf159e29ad0000bfed9c57875908c39268f5ed1257f4958fa6a9f5f60edd54' },
})
function fail(code, message) { throw Object.assign(new Error(message), { code }) }
function safePath(value, allowComma = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000-\u001f\u007f]/.test(value) || (!allowComma && value.includes(','))) fail('LIMA_PATH_INVALID', 'A physical absolute path without control characters or commas is required')
  return value
}
function providerEndpoint(value) {
  let parsed
  try { parsed = new URL(value) } catch { fail('LIMA_PROVIDER_CONFIG_INVALID', 'Provider endpoint must be an absolute HTTP(S) URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    fail('LIMA_PROVIDER_CONFIG_INVALID', 'Provider endpoint must be an HTTP(S) URL without credentials, query, or fragment')
  }
  return parsed.toString().replace(/\/$/u, '')
}
function credentialBinding(file, provider, connection) {
  const result = privateJsonBinding(file, 'Credential record')
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('LIMA_PROVIDER_CONFIG_INVALID', 'Credential record must be valid JSON') }
  const rule = PROVIDER_CONNECTION_RULES[provider]
  let keys = rule?.keys || []
  try {
    if (provider === 'reasonix') {
      const parsed = require('../agents/reasonix/workflow/native.js').connectionConfig(connection.path)
      keys = [...new Set(parsed.providers.map(item => item.api_key_env).filter(Boolean))]
    } else if (['prime', 'omp'].includes(provider)) {
      const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'autoprompt-lima-pi-'))
      try {
        fs.copyFileSync(connection.path, path.join(root, PROVIDER_CONNECTION_FILES[provider]))
        keys = require('./harness-v2-pi-config.cjs').credentialNames(require('./harness-v2-native.cjs').connectionConfig(provider, root))
      } finally { fs.rmSync(root, { recursive: true, force: true }) }
    }
  } catch (error) { fail('LIMA_PROVIDER_CONFIG_INVALID', `Credential binding cannot read the native connection: ${error.message}`) }
  const entries = value && value.environment && typeof value.environment === 'object' && !Array.isArray(value.environment) ? Object.entries(value.environment) : []
  if (!value || value.schemaVersion !== 1 || value.provider !== provider || !rule || !entries.length ||
      !entries.every(([name, secret]) => !FORBIDDEN_CREDENTIAL_NAMES.has(name) && keys.includes(name) && typeof secret === 'string' && secret.length > 0 && secret.length <= 16384)) {
    fail('LIMA_PROVIDER_CONFIG_INVALID', 'Credential record must bind the selected provider to private environment values')
  }
  return result
}
function binding(file, directory = false) {
  safePath(file, true)
  const before = fs.lstatSync(file, { bigint: true })
  if (before.isSymbolicLink() || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n) || fs.realpathSync(file) !== file) fail('LIMA_PATH_UNSAFE', 'A bound path is linked or not physical')
  const result = { path: file, dev: String(before.dev), ino: String(before.ino), mode: Number(before.mode) }
  if (!directory) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const opened = fs.fstatSync(fd, { bigint: true })
      if (opened.dev !== before.dev || opened.ino !== before.ino) fail('LIMA_BINDING_CHANGED', 'A bound file changed while opened')
      result.sha256 = crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')
      const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true })
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) fail('LIMA_BINDING_CHANGED', 'A bound file changed while read')
    } finally { fs.closeSync(fd) }
  }
  return result
}
function assertBinding(expected, directory = false) {
  if (JSON.stringify(binding(expected.path, directory)) !== JSON.stringify(expected)) fail('LIMA_BINDING_CHANGED', 'Backend path identity changed; setup a new backend')
}
function assertConnectionBinding(expected, provider, endpoint) {
  // A descriptor carries the physical file binding plus the reviewed native
  // connection projection.  Recompute both: treating this as a plain file
  // binding would reject every configured backend, while checking only the
  // file would permit a changed endpoint/native projection.
  if (JSON.stringify(connectionBinding(expected.path, provider, endpoint)) !== JSON.stringify(expected)) {
    fail('LIMA_BINDING_CHANGED', 'Native connection binding changed; setup a new backend')
  }
}
function treeBinding(root) {
  const directory = binding(root, true), entries = []
  if ((BigInt(directory.mode) & 0o022n) !== 0n) fail('LIMA_TOOLCHAIN_INVALID', 'Imported runtime closure root must not be group- or world-writable')
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file, { bigint: true })
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file)
        if (!target.startsWith(root + '/')) fail('LIMA_PATH_UNSAFE', 'Toolchain symlink escapes its bound directory')
        entries.push({ path: path.relative(root, file), type: 'link', target: fs.readlinkSync(file) })
      } else if (stat.isDirectory()) {
        if ((stat.mode & 0o022n) !== 0n) fail('LIMA_TOOLCHAIN_INVALID', 'Imported runtime closure must not be group- or world-writable')
        entries.push({ path: path.relative(root, file), type: 'directory', mode: Number(stat.mode) }); visit(file)
      } else {
        if ((stat.mode & 0o022n) !== 0n) fail('LIMA_TOOLCHAIN_INVALID', 'Imported runtime closure must not be group- or world-writable')
        const item = binding(file); entries.push({ ...item, path: path.relative(root, file) })
      }
      if (entries.length > 100000) fail('LIMA_TOOLCHAIN_INVALID', 'Toolchain entry bound exceeded')
    }
  }
  visit(root)
  assertBinding(directory, true)
  // Local identity protects the source before transfer.  The portable digest
  // is deliberately independent of device/inode/time and is verified again
  // in the Linux guest after Lima copies the closure.
  const portable = entries.map(entry => {
    const type = entry.type || 'file'
    // Symlink mode is synthesized differently by macOS and Linux.  The
    // portable import identity binds the link target, path, and type; do not
    // include a transport-specific mode that a copied npm .bin link cannot
    // preserve.
    const item = { path: entry.path, type }
    if (type !== 'link') item.mode = entry.mode
    if (type === 'link') item.target = entry.target
    if (type !== 'directory' && type !== 'link') item.sha256 = entry.sha256
    return item
  })
  return { ...directory, sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'), portableSha256: crypto.createHash('sha256').update(JSON.stringify(portable)).digest('hex') }
}
function assertTree(expected) {
  if (JSON.stringify(treeBinding(expected.path)) !== JSON.stringify(expected)) fail('LIMA_BINDING_CHANGED', 'Bound VM toolchain changed')
}
function privateJsonBinding(file, label) {
  const result = binding(file)
  if (process.platform === 'win32') {
    try { require('../agents/codex/workflow/safe-run-root.js').auditPrivatePermissions(path.dirname(file), { recurse: false, additionalPaths: [file] }) }
    catch (error) { fail('LIMA_PROVIDER_CONFIG_INVALID', `${label} must have a private Windows DACL: ${error.message}`) }
  } else if ((result.mode & 0o077) !== 0) fail('LIMA_PROVIDER_CONFIG_INVALID', `${label} must be private`)
  return result
}
function connectionBinding(file, provider, endpoint) {
  const result = binding(file)
  if (process.platform === 'win32') {
    try { require('../agents/codex/workflow/safe-run-root.js').auditPrivatePermissions(path.dirname(file), { recurse: false, additionalPaths: [file] }) }
    catch (error) { fail('LIMA_PROVIDER_CONFIG_INVALID', `Native connection record must have a private Windows DACL: ${error.message}`) }
  } else if ((result.mode & 0o077) !== 0) fail('LIMA_PROVIDER_CONFIG_INVALID', 'Native connection record must be private')
  const name = PROVIDER_CONNECTION_FILES[provider]
  if (!name) fail('LIMA_PROVIDER_CONFIG_INVALID', 'Provider has no supported native connection format')
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'autoprompt-lima-connection-'))
  try {
    const target = path.join(root, name)
    fs.writeFileSync(target, fs.readFileSync(file), { mode: 0o600 })
    let parsed
    if (provider === 'reasonix') parsed = require('../agents/reasonix/workflow/native.js').connectionConfig(target)
    else if (provider === 'codex') {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
      if (!parsed || parsed.schemaVersion !== 1 || parsed.provider !== 'codex' || Object.keys(parsed).some(key => !['schemaVersion', 'provider'].includes(key))) fail('LIMA_PROVIDER_CONFIG_INVALID', 'Codex connection record must be the exact public codex connection shape')
    } else {
      const env = {}
      const rule = PROVIDER_CONNECTION_RULES[provider]
      if (rule.endpointEnv) env[rule.endpointEnv] = endpoint
      parsed = require('./harness-v2-native.cjs').connectionConfig(provider, root, env)
    }
    // Harnesses that do not consume a documented base-URL environment must
    // carry this exact endpoint in their own reviewed native connection data.
    const rule = PROVIDER_CONNECTION_RULES[provider]
    if (!rule.endpointEnv && !connectionBindsEndpoint(provider, parsed, endpoint)) fail('LIMA_PROVIDER_CONFIG_INVALID', 'Native connection does not bind the supplied endpoint through its reviewed provider route')
    return { ...result, name, connectionIdentitySha256: crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex') }
  } catch (error) {
    if (error.code) throw error
    fail('LIMA_PROVIDER_CONFIG_INVALID', `Native connection is not accepted by ${provider}: ${error.message}`)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
function connectionBindsEndpoint(provider, connection, endpoint) {
  if (['opencode', 'kilo'].includes(provider)) return Object.values(connection.providers || {}).some(item => item?.options?.baseURL === endpoint)
  if (provider === 'vscode') return connection.baseUrl === endpoint
  if (['prime', 'omp'].includes(provider)) return Object.values(connection.providers || {}).some(item => item?.baseUrl === endpoint || item?.models?.some(model => model?.baseUrl === endpoint))
  if (provider === 'reasonix') return (connection.providers || []).some(item => ['base_url', 'chat_url', 'request_url'].some(key => item?.[key] === endpoint))
  return false
}
function modelSelectionBinding(file, provider) {
  const result = privateJsonBinding(file, 'Model selection record')
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('LIMA_PROVIDER_CONFIG_INVALID', 'Model selection record must be valid JSON') }
  try {
    if (provider === 'reasonix') require('./reasonix-configure.cjs').validateSelection(value)
    else if (provider !== 'codex') require('./harness-v2-configure.cjs').validateSelection(value, provider)
    else fail('LIMA_PROVIDER_CONFIG_INVALID', 'Codex model selection must be configured in its bound guest provider root')
  } catch (error) {
    if (error.code === 'LIMA_PROVIDER_CONFIG_INVALID') throw error
    fail('LIMA_PROVIDER_CONFIG_INVALID', `Model selection is not accepted by ${provider}: ${error.message}`)
  }
  return result
}
function makeConfig({ target, arch, vmType, provider }) {
  safePath(target)
  if (!IMAGES[arch] || !['vz', 'qemu'].includes(vmType) || !PUBLIC_PROVIDERS.has(provider)) fail('LIMA_CONFIG_INVALID', 'Explicit supported architecture, VM type, and provider are required')
  const vscodeProvision = provider === 'vscode'
    ? '\nresolve_candidate() {\n  for package in "$@"; do\n    if apt-cache show "$package" 2>/dev/null | grep -q "^Package: "; then printf "%s\\n" "$package"; return 0; fi\n  done\n  return 1\n}\ngtk_package=$(resolve_candidate libgtk-3-0t64 libgtk-3-0)\nasound_package=$(resolve_candidate libasound2t64 libasound2)\napt-get install -y xvfb xauth "$gtk_package" libnss3 "$asound_package" libx11-xcb1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libdrm2 libatk-bridge2.0-0 libcups2 x11-utils\n'
    : ''
  return { vmType, arch, cpus: 2, memory: '4GiB', disk: '20GiB', images: [{ ...IMAGES[arch], arch }],
    mountType: vmType === 'qemu' ? '9p' : 'virtiofs',
    mounts: [{ location: target, mountPoint: target, writable: true,
      // mapped-xattr stores mode bits outside the native macOS inode, making a
      // guest-created 0700 executable appear as host 0600.  With the same
      // guest/host UID, QEMU's `none` model preserves native host modes while
      // tolerating unavailable ownership changes.  Admission still requires
      // an actual shared-mount proof; this is only the transport configuration.
      ...(vmType === 'qemu' ? { '9p': { securityModel: 'none', cache: 'none' } } : {}) }],
    user: { name: 'autoprompt', home: '/home/autoprompt', uid: process.getuid() },
    ssh: { forwardAgent: false }, containerd: { system: false, user: false },
    portForwards: [{ guestPortRange: [1, 65535], ignore: true }],
    // The bound import supplies Node and npm.  Keep Python and PyYAML for the
    // installed controller's runtime/doctor checks, but avoid downloading a
    // second JavaScript runtime during the constrained first boot.
    provision: [{ mode: 'system', script: `#!/bin/sh\nset -eu\nexport DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y python3 python3-yaml git bubblewrap bash\n${vscodeProvision}install -d -m 700 -o autoprompt -g autoprompt /home/autoprompt/runtime\n` }],
  }
}
function controlledEnv(root, limactl, qemuRoot) {
  return { HOME: root, LIMA_HOME: path.join(root, 'lima'), PATH: `${path.dirname(limactl)}:${qemuRoot ? path.join(qemuRoot, 'bin') + ':' : ''}/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8' }
}
function invoke(executable, argv, options) {
  const result = childProcess.spawnSync(executable, argv, { shell: false, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60 * 1000, ...options })
  if (result.error || result.status !== 0) fail('LIMA_COMMAND_FAILED', `Lima command failed: status=${result.status} error=${result.error?.code || ''} ${String(result.stderr || '').slice(-2048)}`)
  return result
}
function guestNodePath(arch) {
  if (!['x86_64', 'aarch64'].includes(arch)) fail('LIMA_CONFIG_INVALID', 'Explicit supported guest architecture is required')
  return `${GUEST_ROOT}/pinned/toolchain/node-v22.23.2-linux-${arch === 'aarch64' ? 'arm64' : 'x64'}/bin/node`
}
function shellArgs(instance, arch, command) {
  if (!/^apvm-[a-f0-9]{16}$/.test(instance)) fail('LIMA_DESCRIPTOR_INVALID', 'Invalid backend instance')
  const guestCommand = command || [guestNodePath(arch), `${GUEST_ROOT}/lima-runtime-guest.cjs`]
  return ['--tty=false', 'shell', `--workdir=${GUEST_ROOT}`, instance, ...guestCommand]
}
function qemuFallbackStartTimeout(vmType, hypervisorSupported) {
  return vmType === 'qemu' && hypervisorSupported === false ? '30m' : null
}
function macHypervisorSupported() {
  if (process.platform !== 'darwin') return undefined
  const probe = childProcess.spawnSync('/usr/sbin/sysctl', ['-n', 'kern.hv_support'], {
    shell: false, encoding: 'utf8', timeout: 5000,
  })
  if (probe.error || probe.status !== 0) return undefined
  const value = String(probe.stdout || '').trim()
  return value === '1' ? true : value === '0' ? false : undefined
}
function setup(input) {
  if (process.platform !== 'darwin') fail('LIMA_HOST_PLATFORM', 'This backend setup requires macOS')
  if (!PUBLIC_PROVIDERS.has(input.provider)) fail('LIMA_PROVIDER_CONFIG_INVALID', 'Provider is not a public Autoprompt provider')
  const root = safePath(input.root), target = binding(input.target, true), tool = binding(input.limactl), archive = binding(input.archive)
  const endpoint = providerEndpoint(input.endpoint), connection = connectionBinding(input.connection, input.provider, endpoint), credential = credentialBinding(input.credential, input.provider, connection)
  const toolchain = treeBinding(safePath(input.toolchain)), native = treeBinding(safePath(input.native))
  const expectedToolchain = `node-v22.23.2-linux-${input.arch === 'aarch64' ? 'arm64' : 'x64'}`
  if (path.basename(toolchain.path) !== expectedToolchain) fail('LIMA_TOOLCHAIN_INVALID', `Pinned toolchain must be named ${expectedToolchain}`)
  if (Buffer.byteLength(path.join(root, 'lima', 'apvm-' + '0'.repeat(16), 'ssh.sock.' + '0'.repeat(16))) >= 104) fail('LIMA_PATH_LIMIT', 'Backend root is too long for macOS Unix sockets; choose a shorter private root')
  if (target.path === root || target.path.startsWith(root + '/') || root.startsWith(target.path + '/')) fail('LIMA_PATH_UNSAFE', 'Backend private state and exported target must be disjoint')
  const resuming = fs.existsSync(root)
  if (resuming && input.resume !== true) fail('LIMA_SETUP_EXISTS', 'Existing setup requires explicit resume')
  if (!resuming) fs.mkdirSync(root, { mode: 0o700 })
  const privateRoot = binding(root, true)
  const providerConfigPath = path.join(root, 'provider-config.json')
  const modelSelection = input.modelSelection ? modelSelectionBinding(input.modelSelection, input.provider) : null
  const providerConfigBytes = JSON.stringify({ schemaVersion: 2, kind: 'lima-guest-provider-config-v1', provider: input.provider, endpoint, target: target.path, credentialSha256: credential.sha256, connectionSha256: connection.sha256, connectionIdentitySha256: connection.connectionIdentitySha256, connectionName: connection.name, nativeSha256: native.portableSha256, toolchainSha256: toolchain.portableSha256, ...(modelSelection ? { modelSelectionSha256: modelSelection.sha256 } : {}) }) + '\n'
  if (fs.existsSync(providerConfigPath)) {
    if (fs.readFileSync(providerConfigPath, 'utf8') !== providerConfigBytes) fail('LIMA_BINDING_CHANGED', 'Guest provider configuration differs from the original setup')
  } else fs.writeFileSync(providerConfigPath, providerConfigBytes, { mode: 0o600, flag: 'wx' })
  const providerConfig = binding(providerConfigPath)
  const limaRoot = treeBinding(path.dirname(path.dirname(tool.path)))
  if (path.join(limaRoot.path, 'bin', 'limactl') !== tool.path) fail('LIMA_TOOLCHAIN_INVALID', 'Lima must be installed as bin/limactl in its complete runtime directory')
  const qemuRoot = input.vmType === 'qemu' ? treeBinding(safePath(input.qemuRoot)) : null
  if (qemuRoot) {
    binding(path.join(qemuRoot.path, 'bin', `qemu-system-${input.arch}`))
    binding(path.join(qemuRoot.path, 'bin', 'qemu-img'))
  }
  const env = controlledEnv(root, tool.path, qemuRoot?.path)
  const version = invoke(tool.path, ['--version'], { env }).stdout.trim()
  if (version !== `limactl version ${VERSION}`) fail('LIMA_VERSION_UNSUPPORTED', `Lima ${VERSION} is required`)
  const config = makeConfig({ target: target.path, arch: input.arch, vmType: input.vmType, provider: input.provider })
  const configPath = path.join(root, 'lima.yaml')
  const configBytes = JSON.stringify(config, null, 2) + '\n'
  if (resuming) {
    if (fs.readFileSync(configPath, 'utf8') !== configBytes) fail('LIMA_BINDING_CHANGED', 'Resume configuration differs from the original setup')
  } else fs.writeFileSync(configPath, configBytes, { mode: 0o600, flag: 'wx' })
  const configBinding = binding(configPath)
  const previous = resuming ? JSON.parse(fs.readFileSync(path.join(root, 'backend.json'), 'utf8')) : null
  const instance = previous ? previous.instance : `apvm-${crypto.randomBytes(8).toString('hex')}`
  shellArgs(instance, input.arch)
  const bridge = binding(path.join(__dirname, 'lima-runtime-guest.cjs'))
  const lifecycle = binding(path.join(__dirname, 'lima-runtime-guest-lifecycle.cjs'))
  const worker = binding(path.join(__dirname, 'lima-runtime-guest-worker.cjs'))
  const vscodeDisplay = input.provider === 'vscode' ? binding(path.join(__dirname, 'lima-runtime-vscode-display.cjs')) : null
  const descriptor = { schemaVersion: 2, kind: 'lima-linux-controller-v1', status: 'CONFIGURED', instance, privateRoot, target,
    provider: input.provider, endpoint, connection, credential, ...(modelSelection ? { modelSelection } : {}), toolchain, native, providerConfig, limactl: tool, limaRoot, qemuRoot, archive, bridge, lifecycle, worker, ...(vscodeDisplay ? { vscodeDisplay } : {}), config: configBinding, image: config.images[0], vmType: input.vmType, arch: input.arch }
  // Persist preparation identity before VM creation for failure diagnosis.
  if (previous) {
    const saved = binding(path.join(root, 'backend.json'))
    if ((saved.mode & 0o077) !== 0 || JSON.stringify(previous) !== JSON.stringify(descriptor)) fail('LIMA_BINDING_CHANGED', 'Resume bindings differ from the original setup')
  } else fs.writeFileSync(path.join(root, 'backend.json'), JSON.stringify(descriptor, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  invoke(tool.path, ['validate', configPath], { env })
  const instanceDirectory = path.join(root, 'lima', instance)
  const fallbackTimeout = qemuFallbackStartTimeout(input.vmType, macHypervisorSupported())
  const startArgs = fs.existsSync(instanceDirectory) ? ['--tty=false', 'start', instance] : ['--tty=false', 'start', '--name', instance, configPath]
  if (fallbackTimeout) startArgs.splice(startArgs.indexOf('start') + 1, 0, '--timeout', fallbackTimeout)
  invoke(tool.path, startArgs, { env })
  assertBinding(target, true); assertBinding(archive); assertBinding(tool); assertConnectionBinding(connection, input.provider, endpoint); assertBinding(credential); if (modelSelection) assertBinding(modelSelection); assertTree(toolchain); assertTree(native); assertBinding(providerConfig); assertBinding(bridge); assertBinding(lifecycle); assertBinding(worker); if (vscodeDisplay) assertBinding(vscodeDisplay); assertTree(limaRoot); if (qemuRoot) assertTree(qemuRoot)
  invoke(tool.path, ['copy', archive.path, `${instance}:${GUEST_ROOT}/package.tgz`], { env })
  invoke(tool.path, ['copy', bridge.path, `${instance}:${GUEST_ROOT}/lima-runtime-guest.cjs`], { env })
  invoke(tool.path, ['copy', lifecycle.path, `${instance}:${GUEST_ROOT}/lima-runtime-guest-lifecycle.cjs`], { env })
  invoke(tool.path, ['copy', worker.path, `${instance}:${GUEST_ROOT}/lima-runtime-guest-worker.cjs`], { env })
  if (vscodeDisplay) invoke(tool.path, ['copy', vscodeDisplay.path, `${instance}:${GUEST_ROOT}/lima-runtime-vscode-display.cjs`], { env })
  invoke(tool.path, ['--tty=false', 'shell', instance, '--', '/bin/sh', '-ceu', `install -d -m 700 ${GUEST_ROOT}/providers/${input.provider} ${GUEST_ROOT}/pinned/toolchain ${GUEST_ROOT}/native`], { env })
  invoke(tool.path, ['copy', '-r', toolchain.path, `${instance}:${GUEST_ROOT}/pinned/toolchain/${expectedToolchain}`], { env })
  invoke(tool.path, ['copy', '-r', native.path, `${instance}:${GUEST_ROOT}/native/${input.provider}`], { env })
  invoke(tool.path, ['copy', connection.path, `${instance}:${GUEST_ROOT}/providers/${input.provider}/${connection.name}`], { env })
  invoke(tool.path, ['copy', credential.path, `${instance}:${GUEST_ROOT}/providers/${input.provider}/credentials.json`], { env })
  if (modelSelection) invoke(tool.path, ['copy', modelSelection.path, `${instance}:${GUEST_ROOT}/providers/${input.provider}/.autoprompt-${input.provider}-models.json`], { env })
  invoke(tool.path, ['copy', providerConfig.path, `${instance}:${GUEST_ROOT}/provider-config.json`], { env })
  invoke(tool.path, ['--tty=false', 'shell', instance, '--', '/bin/sh', '-ceu', `chmod -R go-w ${GUEST_ROOT}/pinned/toolchain/${expectedToolchain} ${GUEST_ROOT}/native/${input.provider}; chmod 600 ${GUEST_ROOT}/providers/${input.provider}/${connection.name} ${GUEST_ROOT}/providers/${input.provider}/credentials.json ${GUEST_ROOT}/provider-config.json${modelSelection ? ` ${GUEST_ROOT}/providers/${input.provider}/.autoprompt-${input.provider}-models.json` : ''}`], { env })
  const targetRecord = path.join(root, 'target.json')
  const targetBytes = JSON.stringify({ target: target.path })
  if (fs.existsSync(targetRecord)) { if (fs.readFileSync(targetRecord, 'utf8') !== targetBytes) fail('LIMA_BINDING_CHANGED', 'Target mapping changed') }
  else fs.writeFileSync(targetRecord, targetBytes, { mode: 0o600, flag: 'wx' })
  invoke(tool.path, ['copy', targetRecord, `${instance}:${GUEST_ROOT}/target.json`], { env })
  const result = invoke(tool.path, shellArgs(instance, input.arch), { env, input: requestLine({ schemaVersion: 1, action: 'setup', archiveSha256: archive.sha256 }) })
  const prepared = { schemaVersion: 1, instanceConfig: binding(path.join(root, 'lima', instance, 'lima.yaml')), providerConfig: binding(providerConfig.path), connection: binding(connection.path), credential: binding(credential.path), toolchain: treeBinding(toolchain.path), native: treeBinding(native.path) }
  const preparedPath = path.join(root, 'prepared.json'), preparedBytes = JSON.stringify(prepared) + '\n'
  if (fs.existsSync(preparedPath)) { if (fs.readFileSync(preparedPath, 'utf8') !== preparedBytes) fail('LIMA_BINDING_CHANGED', 'Prepared VM binding changed') }
  else fs.writeFileSync(preparedPath, preparedBytes, { mode: 0o600, flag: 'wx' })
  return { descriptor, guestOutput: result.stdout }
}
function load(root) {
  safePath(root)
  const file = path.join(root, 'backend.json'), stat = fs.lstatSync(file, { bigint: true })
  if ((stat.mode & 0o077n) !== 0n) fail('LIMA_DESCRIPTOR_INVALID', 'Backend descriptor is not private')
  binding(file)
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (descriptor.schemaVersion !== 2 || descriptor.kind !== 'lima-linux-controller-v1' || descriptor.status !== 'CONFIGURED' || !PUBLIC_PROVIDERS.has(descriptor.provider) || descriptor.endpoint !== providerEndpoint(descriptor.endpoint) || descriptor.privateRoot?.path !== root) fail('LIMA_DESCRIPTOR_INVALID', 'Invalid backend descriptor')
  assertBinding(descriptor.privateRoot, true)
  if ((descriptor.privateRoot.mode & 0o077) !== 0) fail('LIMA_DESCRIPTOR_INVALID', 'Backend directory is not private')
  for (const key of ['limactl', 'archive', 'credential', 'providerConfig', 'bridge', 'lifecycle', 'worker', 'config']) assertBinding(descriptor[key])
  assertConnectionBinding(descriptor.connection, descriptor.provider, descriptor.endpoint)
  if (descriptor.modelSelection) assertBinding(descriptor.modelSelection)
  if (descriptor.vscodeDisplay) assertBinding(descriptor.vscodeDisplay)
  assertTree(descriptor.toolchain); assertTree(descriptor.native)
  assertBinding(descriptor.target, true)
  assertTree(descriptor.limaRoot); if (descriptor.qemuRoot) assertTree(descriptor.qemuRoot)
  const instanceConfig = path.join(root, 'lima', descriptor.instance, 'lima.yaml')
  if (!fs.existsSync(instanceConfig) || !fs.existsSync(path.join(root, 'prepared.json'))) fail('LIMA_SETUP_INCOMPLETE', 'VM preparation has not completed')
  const preparedFile = path.join(root, 'prepared.json'); const preparedItem = binding(preparedFile)
  if ((preparedItem.mode & 0o077) !== 0) fail('LIMA_DESCRIPTOR_INVALID', 'Preparation record is not private')
  const prepared = JSON.parse(fs.readFileSync(preparedFile, 'utf8'))
  if (prepared.schemaVersion !== 1 || prepared.instanceConfig?.path !== instanceConfig || prepared.providerConfig?.sha256 !== descriptor.providerConfig.sha256 || prepared.connection?.sha256 !== descriptor.connection.sha256 || prepared.credential?.sha256 !== descriptor.credential.sha256 || prepared.toolchain?.sha256 !== descriptor.toolchain.sha256 || prepared.native?.sha256 !== descriptor.native.sha256) fail('LIMA_DESCRIPTOR_INVALID', 'Invalid prepared instance binding')
  assertBinding(prepared.instanceConfig); assertBinding(prepared.providerConfig); assertBinding(prepared.connection); assertBinding(prepared.credential); assertTree(prepared.toolchain); assertTree(prepared.native)
  return descriptor
}
function requestId(value) {
  const result = value === undefined ? crypto.randomBytes(16).toString('hex') : value
  if (typeof result !== 'string' || !/^[a-f0-9]{32}$/.test(result)) fail('LIMA_REQUEST_INVALID', 'Request ID must contain exactly 32 lowercase hexadecimal characters')
  return result
}
function requestLine(request) {
  // Both the one-shot setup bridge and the persistent lifecycle bridge use a
  // newline-delimited request protocol.  Keep their framing in one helper so
  // setup cannot silently diverge from transport().
  return `${JSON.stringify(request)}\n`
}
function transport(descriptor, root, request) {
  // Keep stdin open after the request line.  The guest bridge treats an EOF as
  // cancellation, so spawnSync is both unsafe and unable to report a durable
  // post-disconnect outcome.
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(descriptor.limactl.path, shellArgs(descriptor.instance, descriptor.arch), {
      shell: false, env: controlledEnv(root, descriptor.limactl.path, descriptor.qemuRoot?.path), stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = [], stderr = []; let bytes = 0; let settled = false
    const append = (list, chunk) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) { child.kill('SIGTERM'); return }
      list.push(chunk)
    }
    child.stdout.on('data', chunk => append(stdout, chunk))
    child.stderr.on('data', chunk => append(stderr, chunk))
    child.once('error', error => {
      if (settled) return
      settled = true
      // The request was admitted to a local transport but no guest terminal
      // receipt reached us.  Reconnect with this exact ID; never infer a
      // mission result from a damaged SSH/Lima channel.
      resolve({ schemaVersion: 1, status: 'UNKNOWN', requestId: request.requestId, transportError: error.code || 'SPAWN_FAILED' })
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      const text = Buffer.concat(stdout).toString('utf8').trim()
      if (code === 0 && text) {
        try { return resolve(JSON.parse(text)) } catch { /* handled below */ }
      }
      if (!text) return resolve({ schemaVersion: 1, status: 'UNKNOWN', requestId: request.requestId, transportError: `LIMA_EXIT_${code ?? 'UNKNOWN'}` })
      try { fail('LIMA_COMMAND_FAILED', `Lima command failed: status=${code} ${Buffer.concat(stderr).toString('utf8').slice(-2048)}`) } catch (error) { reject(error) }
    })
    child.stdin.once('error', () => {})
    child.stdin.write(requestLine(request))
  })
}
function exec(input) {
  const id = requestId(input.requestId)
  const request = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'exec', requestId: id, argv: input.argv })))
  const descriptor = load(input.root)
  if (typeof input.onRequest === 'function') input.onRequest(id)
  return transport(descriptor, input.root, request)
}
function status(input) {
  const request = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'status', ...(input.requestId !== undefined ? { requestId: requestId(input.requestId) } : {}) })))
  return transport(load(input.root), input.root, request)
}
function cancel(input) {
  const id = requestId(input.requestId)
  const request = parseRequest(Buffer.from(JSON.stringify({ schemaVersion: 1, action: 'cancel', requestId: id })))
  return transport(load(input.root), input.root, request)
}
module.exports = { setup, status, exec, cancel, load, makeConfig, binding, credentialBinding, connectionBinding, assertConnectionBinding, modelSelectionBinding, providerEndpoint, PROVIDER_CONNECTION_RULES, PROVIDER_CONNECTION_FILES, connectionBindsEndpoint, treeBinding, guestNodePath, shellArgs, qemuFallbackStartTimeout, macHypervisorSupported, requestId, requestLine, transport, VERSION, IMAGES }
