#!/usr/bin/env node
'use strict'

// Development evidence only. This program cannot issue or install admission.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const PROVIDERS = Object.freeze({
  codex: { command: 'codex', help: ['exec', '--help'], flags: ['--json', '--output-schema', '--sandbox'] },
  claude: { command: 'claude', help: ['--help'], flags: ['--output-format', '--resume', '--strict-mcp-config'] },
  opencode: { command: 'opencode', help: ['run', '--help'], flags: ['--format', '--session'] },
  kilo: { command: 'kilo', help: ['run', '--help'], flags: ['--format', '--session'] },
  vscode: { command: 'code', help: ['--help'], flags: ['--user-data-dir', '--extensions-dir'] },
  prime: { command: 'prime-agent', help: ['--help'], flags: ['--mode', '--resume', '--session-dir'] },
  omp: { command: 'omp', help: ['--help'], flags: ['--mode', '--session'] },
  deepseek: { command: 'dsh', help: ['--help'], flags: ['--profile'] },
  reasonix: { command: 'reasonix', help: ['run', '--help'], flags: ['--output-format', '--resume', '--dir', '--max-steps', '--permission-mode'] },
})
const CAPABILITIES = ['isolation', 'topologyEnforcement', 'privateSkillRoot', 'eventStreaming', 'toolOutputCapture', 'stableChildIdentity', 'sameContextContinuation', 'cancellation', 'isolatedChecking', 'processOwnership', 'modelRouting']
// Register actual-binary suites explicitly. A protocol parser fixture, a skipped
// native test, or an unrelated test's passing totals cannot satisfy this check.
const NATIVE_SUITES = Object.freeze(Object.fromEntries([
  ...['claude', 'opencode', 'kilo'].map(provider => [provider, {
    file: 'tests/source/harness-v2-adapter-native.test.cjs',
    cases: [`${provider} production adapter: owned tools preserve candidate, private state and exact session continuation`],
  }]),
  ...['prime', 'omp'].map(provider => [provider, {
    file: 'tests/source/harness-v2-pi-adapter-native.test.cjs',
    cases: [`${provider} real production adapter preserves owned command boundaries, exact usage and resumed history`],
  }]),
  ['deepseek', {
    file: 'tests/source/harness-v2-adapter-native.test.cjs',
    cases: ['deepseek production adapter: owned tools preserve candidate, private state and exact session continuation'],
  }],
  ['reasonix', {
    file: 'tests/source/reasonix-controlled-native.test.cjs',
    cases: [
      'real Reasonix production adapter keeps candidate read-only, scratch writable, controller private, and resumes',
      'real Reasonix production adapter writes only its assigned target and validates terminal schema',
      'real Reasonix production adapter cancels and drains an active request',
    ],
  }],
  ['vscode', {
    file: 'tests/source/harness-v2-vscode-owned-native.test.cjs',
    cases: [
      'real VS Code owned BYOK session executes controlled tools, bills exact usage, and resumes privately',
      'real VS Code concurrent owned sessions isolate sibling cancellation and drain',
    ],
  }],
].map(([provider, suite]) => [provider, Object.freeze({ ...suite, cases: Object.freeze(suite.cases) })])))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const status = (value, reason, extra = {}) => ({ status: value, reason, ...extra })
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function nativeTestPlan(provider, root = ROOT) {
  if (!Object.hasOwn(NATIVE_SUITES, provider)) return null
  const suite = NATIVE_SUITES[provider]
  const file = path.join(root, suite.file)
  const pattern = `^(?:${suite.cases.map(escapeRegex).join('|')})$`
  return { file, cases: [...suite.cases],
    argv: ['--test', '--test-concurrency=1', '--test-reporter=tap', '--test-name-pattern', pattern, file],
    executableEnvironmentKey: `AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI` }
}

function selectedCaseSummary(text, names) {
  return names.map(name => {
    const pattern = new RegExp(`^(ok|not ok) \\d+ - ${escapeRegex(name)}(?:\\s+# (SKIP|TODO)(?:\\s.*)?)?\\s*$`, 'gm')
    const matches = [...text.matchAll(pattern)]
    const result = matches.length !== 1 ? (matches.length ? 'ambiguous' : 'not-observed')
      : matches[0][2] ? 'skipped' : matches[0][1] === 'ok' ? 'passed' : 'failed'
    return { name, status: result }
  })
}

function suiteCompleted(tested, counts, cases) {
  // Node versions may report nonselected tests as skipped. Only the explicitly
  // named cases must pass, once each; zero failures/cancellations is not enough.
  return tested.ok && cases.length > 0 && cases.every(item => item.status === 'passed') &&
    counts.pass === cases.length && Number.isSafeInteger(counts.skipped) && counts.skipped >= 0 &&
    counts.tests === counts.pass + counts.skipped && counts.fail === 0 && counts.cancelled === 0 &&
    (counts.todo ?? 0) === 0
}

function parseArgs(argv) {
  const options = { providers: [], executables: {}, nativeTests: false, integrationTests: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--native-tests') options.nativeTests = true
    else if (arg === '--integration-tests') options.integrationTests = true
    else if (arg === '--help') options.help = true
    else if (['--provider', '--executable', '--output'].includes(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--provider') options.providers.push(value)
      if (arg === '--output') options.output = value
      if (arg === '--executable') {
        const separator = value.indexOf('=')
        if (separator < 1 || separator === value.length - 1) throw new Error('--executable requires provider=/absolute/path')
        const provider = value.slice(0, separator)
        if (!Object.hasOwn(PROVIDERS, provider) || !path.isAbsolute(value.slice(separator + 1))) throw new Error('Invalid executable provider or nonabsolute path')
        options.executables[provider] = value.slice(separator + 1)
      }
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.providers.length) options.providers = Object.keys(PROVIDERS)
  options.providers = [...new Set(options.providers)]
  if (options.providers.some(provider => !Object.hasOwn(PROVIDERS, provider))) throw new Error('Unknown provider')
  return options
}

function isolatedEnvironment(root, source = process.env) {
  const env = {}
  // Do not inherit credentials, NODE_OPTIONS, provider homes, hooks or proxies.
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL']) if (source[key]) env[key] = source[key]
  for (const name of ['home', 'config', 'state', 'cache', 'temp', 'cwd']) fs.mkdirSync(path.join(root, name), { mode: 0o700 })
  Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TEMP: path.join(root, 'temp'),
    NO_COLOR: '1', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'home', '.gitconfig') })
  for (const provider of Object.keys(PROVIDERS)) env[`${provider.toUpperCase()}_HOME`] = path.join(root, 'home', provider)
  env.REASONIX_STATE_HOME = path.join(root, 'state', 'reasonix')
  env.REASONIX_CACHE_HOME = path.join(root, 'cache', 'reasonix')
  env.CLAUDE_CONFIG_DIR = path.join(root, 'config', 'claude')
  env.PI_CODING_AGENT_DIR = path.join(root, 'config', 'omp')
  return env
}

function discover(provider, env, requested) {
  const command = PROVIDERS[provider].command
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates = requested ? [requested] : (env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(directory => extensions.map(extension => path.resolve(directory, command + extension)))
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate)
      if (!fs.statSync(resolved).isFile()) continue
      fs.accessSync(resolved, fs.constants.X_OK)
      return status('supported', 'Executable discovered; provenance and behavioral compatibility are unverified', { path: resolved, sha256: sha256(fs.readFileSync(resolved)), provenance: 'unverified' })
    } catch { /* An absent or inaccessible candidate is not runnable. */ }
  }
  return status('not-tested', requested ? 'Requested executable is absent or inaccessible' : 'Executable not found on PATH')
}

function writeEvidence(directory, name, bytes) {
  const file = path.join(directory, name)
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
  return { path: file, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) }
}

function capture(directory, name, executable, argv, env, spawn = cp.spawnSync, timeout = 15000) {
  const stdoutPath = path.join(directory, `${name}.stdout`)
  const stderrPath = path.join(directory, `${name}.stderr`)
  const out = fs.openSync(stdoutPath, 'wx', 0o600)
  const err = fs.openSync(stderrPath, 'wx', 0o600)
  let result
  try {
    // File capture also works where anonymous pipe creation is restricted.
    result = spawn(executable, argv, { cwd: path.join(directory, 'cwd'), env, shell: false, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', out, err] })
    if (result.stdout) fs.writeSync(out, String(result.stdout))
    if (result.stderr) fs.writeSync(err, String(result.stderr))
  } finally { fs.closeSync(out); fs.closeSync(err) }
  const read = file => {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    const bytes = Buffer.alloc(Math.min(size, 4 * 1024 * 1024))
    try { fs.readSync(fd, bytes, 0, bytes.length, 0) } finally { fs.closeSync(fd) }
    return { text: bytes.toString('utf8'), evidence: { path: file, sha256: sha256(bytes), bytes: bytes.length, totalBytes: size, truncated: size > bytes.length } }
  }
  const stdout = read(stdoutPath)
  const stderr = read(stderrPath)
  const record = { executable, argv, exitCode: result.status ?? null, signal: result.signal || null,
    errorCode: result.error?.code || null,
    stdout: stdout.evidence, stderr: stderr.evidence }
  return { record, stdout: stdout.text, stderr: stderr.text, ok: !result.error && !result.signal && result.status === 0 && !stdout.evidence.truncated && !stderr.evidence.truncated }
}

function testSummary(text) {
  const summary = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))]
    if (matches.length) summary[key] = Number(matches.at(-1)[1])
  }
  return summary
}

function inspectProvider(provider, options, evidenceRoot) {
  const directory = path.join(evidenceRoot, provider)
  fs.mkdirSync(directory, { mode: 0o700 })
  const env = isolatedEnvironment(directory, options.env)
  const executable = discover(provider, env, options.executables?.[provider])
  const result = { provider, executable, evidenceDirectory: directory, commands: [],
    version: status('not-tested', 'Executable has not been probed'),
    nativeInterface: status('not-tested', 'Executable has not been probed'),
    capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, status('unknown', 'Requires behavioral evidence bound to this executable and runtime')])),
    nativeTests: status('not-tested', 'Native suite not requested'),
    liveModelConformance: status('not-tested', 'No independent live-model conformance is run by this diagnostic'),
    productionAdmission: status('unknown', 'Diagnostic evidence does not evaluate or grant signed production admission'), admissionGranted: false }
  if (executable.status !== 'supported') return result
  const version = capture(directory, 'version', executable.path, ['--version'], env, options.spawnSync)
  const help = capture(directory, 'help', executable.path, PROVIDERS[provider].help, env, options.spawnSync)
  result.commands.push(version.record, help.record)
  const match = version.ok && /(?:^|[^A-Za-z0-9])v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?=$|[^A-Za-z0-9.+-])/.exec(version.stdout + '\n' + version.stderr)
  result.version = match ? status('supported', 'Version string observed from executable', { exact: match[1], evidence: version.record.stdout }) : status('unknown', 'Could not obtain an exact version', { errorCode: version.record.errorCode })
  const helpText = help.stdout + '\n' + help.stderr
  const flags = PROVIDERS[provider].flags.map(flag => ({ flag, ...status(help.ok ? (helpText.includes(flag) ? 'supported' : 'unsupported') : 'unknown', 'Help advertisement only; behavior not established') }))
  result.nativeInterface = status(!help.ok ? 'unknown' : flags.some(flag => flag.status === 'unsupported') ? 'unsupported' : flags.length ? 'supported' : 'unknown', 'Limited CLI help check; does not establish transport or safety capabilities', { flags, evidence: help.record.stdout })
  const modulePath = provider === 'reasonix' ? path.join(ROOT, 'agents/reasonix/workflow/native.js') : path.join(ROOT, 'scripts/harness-v2-native.cjs')
  if (provider !== 'codex' && fs.existsSync(modulePath)) {
    let sequence = 0
    try {
      const probe = require(modulePath).probeExecutable({ provider, executable: executable.path, env,
        spawnSync: (file, argv) => {
          const captured = capture(directory, `adapter-probe-${++sequence}`, file, argv, env, options.spawnSync)
          result.commands.push(captured.record)
          return { stdout: captured.stdout, stderr: captured.stderr, status: captured.record.exitCode,
            ...(captured.record.errorCode ? { error: Object.assign(new Error('Probe process failed'), { code: captured.record.errorCode }) } : {}) }
        } })
      result.adapterProbe = status('supported', 'Adapter preflight accepted; this is not native behavioral conformance', { version: probe.version, evidenceHashes: probe.evidenceHashes || [], declaredCapabilities: probe.capabilities || null,
        nativeRuntimeIdentity: probe.runtimeIdentity || null })
    } catch (error) {
      result.adapterProbe = status(error.code === 'PROVIDER_UNSUPPORTED' ? 'unsupported' : 'unknown', 'Adapter preflight refused; inspect bounded command evidence', { errorCode: error.code || 'PROBE_FAILED' })
    }
  } else result.adapterProbe = status('not-tested', 'No general diagnostic probe is available for this provider')
  if (sha256(fs.readFileSync(executable.path)) !== executable.sha256) {
    result.executable = status('unsupported', 'Executable changed during diagnostic; results cannot be bound')
    return result
  }
  if (options.nativeTests) {
    const plan = nativeTestPlan(provider)
    if (!plan) result.nativeTests = status('not-tested', 'No actual-binary native suite registered; parser fixtures are not conformance')
    else if (!fs.existsSync(plan.file)) result.nativeTests = status('not-tested', 'The registered native suite is available only in the source checkout, not this installed diagnostic package', { suite: NATIVE_SUITES[provider].file })
    else {
      const nativeEnv = { ...env, [plan.executableEnvironmentKey]: executable.path,
        AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT: path.join(directory, 'native-wire') }
      if (provider === 'vscode') for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']) {
        const value = (options.env || process.env)[key]
        if (typeof value === 'string') nativeEnv[key] = value
      }
      const tested = capture(directory, 'native-tests', process.execPath, plan.argv, nativeEnv, options.spawnSync, 300000)
      const counts = testSummary(tested.stdout)
      const cases = selectedCaseSummary(tested.stdout, plan.cases)
      const complete = suiteCompleted(tested, counts, cases)
      result.commands.push(tested.record)
      result.nativeTests = status(complete ? 'supported' : counts.fail > 0 || cases.some(item => item.status === 'failed') ? 'unsupported' : 'unknown', 'Actual executable with deterministic localhost model service; not live-model conformance', {
        suite: NATIVE_SUITES[provider].file, counts, cases, evidence: tested.record.stdout,
        errorCode: tested.record.errorCode, scope: 'native-binary-local-model-service',
      })
      // Tests launch the bound executable again. A pre-test digest alone cannot
      // establish which binary actually produced the recorded observations.
      let unchanged = false
      try {
        unchanged = sha256(fs.readFileSync(executable.path)) === executable.sha256
        if (unchanged && result.adapterProbe.nativeRuntimeIdentity) {
          unchanged = JSON.stringify(require(modulePath).runtimeDependencyIdentity(executable.path)) ===
            JSON.stringify(result.adapterProbe.nativeRuntimeIdentity)
        }
      } catch {}
      if (!unchanged) {
        result.executable = status('unsupported', 'Executable changed or disappeared during native testing; results cannot be bound')
        result.nativeTests = { ...result.nativeTests, status: 'unknown', reason: 'Native observations cannot be bound to the original executable' }
      }
    }
  }
  return result
}

function run(options = {}) {
  const evidenceRoot = options.output ? path.resolve(options.output) : fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-harness-v2-evidence-'))
  if (options.output) fs.mkdirSync(evidenceRoot, { mode: 0o700 }) // Refuse existing paths and overwrite.
  const providers = options.providers || Object.keys(PROVIDERS)
  if (providers.some(provider => !Object.hasOwn(PROVIDERS, provider))) throw new Error('Unknown provider')
  const report = { schemaVersion: 'harness-v2-local-diagnostic.v1', createdAt: new Date().toISOString(),
    evidenceKind: options.spawnSync ? 'injected-process-tests' : 'local-executable-diagnostic',
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, supportedNode: Number(process.versions.node.split('.')[0]) >= 20 },
    evidenceDirectory: evidenceRoot, admissionGranted: false,
    providers: providers.map(provider => inspectProvider(provider, options, evidenceRoot)),
    integrationTests: status('not-tested', 'Public CLI integration suite not requested') }
  if (options.integrationTests) {
    const directory = path.join(evidenceRoot, 'integration')
    fs.mkdirSync(directory, { mode: 0o700 })
    const env = isolatedEnvironment(directory, options.env)
    const tested = capture(directory, 'integration-tests', process.execPath, [path.join(ROOT, 'tests/source/harness-v2-integration.test.cjs')], env, options.spawnSync, 120000)
    const counts = testSummary(tested.stdout)
    report.integrationTests = status(tested.ok && counts.pass > 0 && counts.fail === 0 ? 'supported' : 'unknown', 'Local CLI/bundle diagnostic and refusal tests only; not provider conformance', { counts, evidence: tested.record })
  }
  writeEvidence(evidenceRoot, 'report.json', JSON.stringify(report, null, 2) + '\n')
  return report
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node scripts/harness-v2-conformance.cjs [--provider NAME] [--executable NAME=/absolute/path] [--output NEW_DIRECTORY] [--native-tests] [--integration-tests]\nWrites local diagnostic evidence only. Never grants production admission.\n')
    else process.stdout.write(JSON.stringify(run(options), null, 2) + '\n')
  } catch (error) { process.stderr.write(`DIAGNOSTIC_FAILED: ${error.message}\n`); process.exitCode = 1 }
}

module.exports = { PROVIDERS, CAPABILITIES, NATIVE_SUITES, nativeTestPlan, selectedCaseSummary, suiteCompleted,
  parseArgs, isolatedEnvironment, discover, testSummary, run }
