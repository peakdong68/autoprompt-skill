'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const test = require('node:test')
const diagnostic = require('../../scripts/harness-v2-conformance.cjs')
const ROOT = path.resolve(__dirname, '../..')
const temporary = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

test('diagnostic arguments accept exact paths and reject unknown providers and bypass switches', () => {
  const exact = path.resolve('/tmp/path with spaces=and=equals')
  const parsed = diagnostic.parseArgs(['--provider', 'reasonix', '--executable', `reasonix=${exact}`, '--native-tests'])
  assert.equal(parsed.executables.reasonix, exact)
  assert.deepEqual(parsed.providers, ['reasonix'])
  for (const args of [['--provider', 'unknown'], ['--executable', 'reasonix=relative'], ['--admit'], ['--trust-local'], ['--output']]) assert.throws(() => diagnostic.parseArgs(args))
})

test('diagnostics omit user credentials and configuration overrides from probe environments', () => {
  const root = temporary('harness-diagnostic-environment-')
  try {
    const env = diagnostic.isolatedEnvironment(root, { PATH: '/bin', HOME: '/foreign', REASONIX_HOME: '/foreign-reasonix', OPENAI_API_KEY: 'secret-sentinel', NODE_OPTIONS: '--require foreign.js', BASH_ENV: '/foreign-hook', HTTP_PROXY: 'http://secret-sentinel', CLAUDE_CONFIG_DIR: '/foreign-claude' })
    assert.equal(env.PATH, '/bin')
    assert.equal(env.HOME, path.join(root, 'home'))
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.BASH_ENV, undefined)
    assert.equal(env.HTTP_PROXY, undefined)
    assert.equal(JSON.stringify(env).includes('secret-sentinel'), false)
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(root, 'config/claude'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('missing executable produces explicit not-tested results and durable diagnostic evidence', () => {
  const root = temporary('harness-diagnostic-absent-')
  try {
    const report = diagnostic.run({ providers: ['reasonix'], env: { PATH: '' }, output: path.join(root, 'evidence'), nativeTests: true })
    assert.equal(report.admissionGranted, false)
    assert.equal(report.providers[0].executable.status, 'not-tested')
    assert.equal(report.providers[0].nativeTests.status, 'not-tested')
    assert.equal(report.providers[0].liveModelConformance.status, 'not-tested')
    assert.ok(Object.values(report.providers[0].capabilities).every(item => item.status === 'unknown'))
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json'))), report)
    assert.throws(() => diagnostic.run({ providers: ['reasonix'], output: path.join(root, 'evidence') }), { code: 'EEXIST' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('injected help and skipped native tests can never be promoted into provider conformance', () => {
  const root = temporary('harness-diagnostic-injected-')
  try {
    const seen = []
    const report = diagnostic.run({ providers: ['reasonix'], executables: { reasonix: process.execPath }, output: path.join(root, 'evidence'), nativeTests: true,
      spawnSync: (executable, argv, options) => {
        seen.push({ executable, argv, options })
        return { status: 0, stdout: argv[0] === '--version' ? 'reasonix v1.30.0\n' : argv.includes('--help') ? '--output-format --resume --dir --max-steps --permission-mode' : '# tests 3\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 3\n', stderr: '' }
      } })
    const provider = report.providers[0]
    assert.equal(report.evidenceKind, 'injected-process-tests')
    assert.equal(provider.version.exact, '1.30.0')
    assert.equal(provider.nativeInterface.status, 'supported')
    assert.equal(provider.nativeTests.status, 'unknown')
    assert.equal(provider.liveModelConformance.status, 'not-tested')
    assert.equal(provider.admissionGranted, false)
    assert.ok(Object.values(provider.capabilities).every(item => item.status === 'unknown'))
    assert.ok(seen.every(call => call.options.shell === false))
    for (const command of provider.commands) assert.ok(fs.existsSync(command.stdout.path))
    assert.equal(fs.existsSync(path.join(root, 'evidence/attestation.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a failed or truncated native suite cannot pass diagnostic verification', () => {
  const root = temporary('harness-diagnostic-failed-')
  try {
    const report = diagnostic.run({ providers: ['reasonix'], executables: { reasonix: process.execPath }, output: path.join(root, 'evidence'), nativeTests: true,
      spawnSync: (_executable, argv) => argv[0] === '--version' ? { status: 0, stdout: 'reasonix v1.30.0' } : argv.includes('--help') ? { status: 0, stdout: '--output-format --resume --dir --max-steps --permission-mode' } : { status: 1, stdout: '# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n' } })
    assert.equal(report.providers[0].nativeTests.status, 'unsupported')
    assert.equal(report.admissionGranted, false)
    assert.deepEqual(diagnostic.testSummary('# tests 1\n# pass 1\n'), { tests: 1, pass: 1 })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// Real public Node CLI -> installed bundle -> refusal. The test uses no model,
// provider imitation, trusted-key changes, or production admission overrides.
// File stdio avoids anonymous-pipe EPERM in restricted Linux environments.
function runCli(root, argv, env) {
  const outputPath = path.join(root, `cli-${require('node:crypto').randomUUID()}.log`)
  const fd = fs.openSync(outputPath, 'wx', 0o600)
  let result
  try { result = cp.spawnSync(process.execPath, [path.join(ROOT, 'bin/autoprompt.cjs'), ...argv], { cwd: root, env, shell: false, stdio: ['ignore', fd, fd], timeout: 30000 }) }
  finally { fs.closeSync(fd) }
  if (result.error) throw result.error
  return { ...result, output: fs.readFileSync(outputPath, 'utf8') }
}

for (const provider of ['reasonix', 'claude', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok']) {
  test(`real public ${provider} CLI loads its installed v2 bundle and refuses an absent native process`, { timeout: 60000 }, () => {
    const root = temporary(`harness-v2-cli-${provider}-`)
    try {
      const env = diagnostic.isolatedEnvironment(root)
      env.PATH = path.join(root, 'empty-path')
      fs.mkdirSync(env.PATH)
      const destination = path.join(root, 'installation')
      const target = path.join(root, 'target')
      fs.mkdirSync(target)
      const packaging = require(provider === 'reasonix' ? '../../scripts/reasonix-package.cjs' : '../../scripts/harness-v2-package.cjs')
      const installed = provider === 'reasonix' ? packaging.install(destination) : packaging.install(provider, destination)
      assert.equal(installed.contractVersion, '2.0.0')
      const result = runCli(root, ['activate', provider, '--root', destination, '--target', target, '--', 'check only'], env)
      assert.notEqual(result.status, 0, result.output)
      assert.match(result.output, /PROVIDER_UNSUPPORTED|not installed|not executable|Node\.js .*required|Node\.js 20/i)
      assert.doesNotMatch(result.output, /MODULE_NOT_FOUND|Cannot find module|Unknown provider|Unknown command/)
      assert.equal(fs.existsSync(path.join(destination, '.autoprompt-private', 'activations')), false)
      assert.deepEqual(fs.readdirSync(target), [])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test('Reasonix launch forwards the exact mission argument array into the installed bundle', () => {
  const root = temporary('harness-v2-forwarding-')
  try {
    const destination = path.join(root, 'installation')
    const installed = require('../../scripts/reasonix-package.cjs').install(destination)
    const configure = require('../../scripts/reasonix-configure.cjs')
    const missionArgs = ['spaces stay together', '', '--literal-flag', 'quote"', 'line\nbreak', '$(must-not-run)', 'café']
    let captured
    const result = configure.launchActivation({ env: { ...process.env, AUTOPROMPT_INSTALL_ROOT: destination }, target: root, missionArgs,
      spawnSync: (executable, argv, options) => {
        assert.equal(executable, process.execPath)
        assert.equal(argv[0], path.join(installed.bundle, 'scripts/reasonix-configure.cjs'))
        assert.equal(argv[1], '--supervise')
        assert.equal(options.shell, false)
        captured = JSON.parse(fs.readFileSync(argv[2], 'utf8'))
        return { status: 1 }
      } })
    assert.equal(result.status, 1)
    assert.deepEqual(captured.missionArgs, missionArgs)
    assert.equal(captured.target, root)
    assert.equal(fs.readdirSync(path.join(destination, '.autoprompt-private')).some(name => name.startsWith('launch-')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
