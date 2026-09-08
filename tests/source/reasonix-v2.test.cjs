'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const toml = require('@iarna/toml')
const generator = require('../../scripts/generate-provider-contracts.cjs')
const native = require('../../agents/reasonix/workflow/native.js')
const { ReasonixEventStream } = require('../../agents/reasonix/workflow/transport.js')

test('native preflight refuses a CLI missing the permission-mode flag used at launch', () => {
  assert.throws(() => native.probeExecutable({ executable: process.execPath, spawnSync: (_file, argv) => ({
    status: 0, stdout: argv[0] === '--version' ? 'reasonix v1.30.0' : '--output-format --resume --dir --max-steps', stderr: '',
  }) }), { code: 'PROVIDER_UNSUPPORTED' })
})

test('native adapter refuses terminal JSON when the owned process failed or was cancelled', async t => {
  const core = require('../../agents/codex/workflow/phase-budget.js')
  const { ReasonixExecAdapter } = require('../../agents/reasonix/workflow/transport.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-process-result-'))
  try {
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { mode: 0o700 })
    // This is a controller regression test with an injected runner, not native conformance.
    for (const [name, implementation] of Object.entries({
      validateCanonicalMissionLaunch: () => ({}), codexProviderCanonicalOutputSchema: () => ({ type: 'object' }),
      codexPrivateWorkspaceProjection: () => [], codexExplicitExternalLocalProjection: () => [], codexCheckerScratchProjection: () => [],
      modelVisibleDispatch: () => ({}), checkerResultBoundToCommandExecutionEvidence: output => output,
    })) t.mock.method(core, name, implementation)
    const schema = path.join(root, 'schema.json')
    fs.writeFileSync(schema, '{}')
    const executable = path.join(root, 'test-executable')
    fs.writeFileSync(executable, 'not a native binary')
    for (const [index, processResult] of [{ status: 1, signal: null }, { status: 0, signal: 'OWNED_STOP' }, { status: null, signal: 'SIGTERM' }].entries()) {
      const adapter = new ReasonixExecAdapter({ nativeRoot: path.join(root, `native-${index}`), connection: { providers: [] },
        executableBinding: { path: executable, sha256: native.sha256(fs.readFileSync(executable)) },
        outputSchemaResolver: () => schema, rolePrompt: () => 'Return JSON.', targetPath: target,
        runner: { run: async spec => {
          spec.onStdoutLine(JSON.stringify({ kind: 'usage', usage: { promptTokens: 10, cacheHitTokens: 0, completionTokens: 2 } }))
          spec.onStdoutLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: `native-${index}`, result: '{}', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 } }))
          return { ...processResult, processOwned: true, exactArgv: true, drained: true }
        }, stop: async () => ({ drained: true }) },
      })
      await assert.rejects(adapter.launch({ sessionId: `session-${index}`, reservationId: `reservation-${index}`,
        logicalRole: 'worker', providerRole: 'ap-worker', physicalRole: 'ap-worker',
        physicalExecutionPolicy: { logicalRole: 'worker', providerRole: 'ap-worker', physicalRole: 'ap-worker', sandboxMode: 'read-only' },
      }), { code: 'CHILD_RUNTIME_FAILURE' })
    }
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('Reasonix v2 projects every reviewed role and canonical route/check table', () => {
  const outputs = generator.renderReasonixOutputs()
  const policy = JSON.parse(outputs.get('agents/reasonix/role-policy.json'))
  const source = require('../../agents/codex/agents/role-policy.json')
  assert.deepEqual(policy.physical_roles, source.physical_roles)
  assert.equal(Object.keys(policy.physical_roles).length, 32)
  for (const [id, role] of Object.entries(policy.physical_roles)) {
    const text = outputs.get(`agents/reasonix/skills/${id}/SKILL.md`)
    assert.ok(text)
    assert.ok(text.includes(`read-only: ${role.sandbox_mode === 'read-only'}`))
    const tools = JSON.parse(text.match(/^allowed-tools: (.+)$/m)[1])
    assert.equal(tools.some(tool => native.FORBIDDEN_TOOLS.includes(tool)), false)
  }
  const contracts = generator.loadCodexV2Contracts()
  assert.deepEqual(generator.parseFullCompiledGates(outputs.get('agents/reasonix/GATES.md')),
    generator.parseFullCompiledGates(generator.renderCodexOutputs().get('agents/codex/GATES.md')))
  assert.equal(generator.providerProjectionPlan(contracts).find(record => record.provider === 'reasonix').portOpen, true)
})

test('native private config excludes user runtime extensions and isolates checker writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-config-'))
  try {
    const file = path.join(root, 'config.toml')
    fs.writeFileSync(file, toml.stringify({
      default_model: 'fixture', providers: [{ name: 'fixture', kind: 'openai', model: 'test', base_url: 'http://127.0.0.1:1/v1', api_key_env: 'FIXTURE_KEY' }],
      agent: { system_prompt: 'foreign instructions' }, hooks: { stop: 'foreign command' },
      permissions: { deny: [], mode: 'bypassPermissions' }, skills: { paths: ['/foreign'] },
    }))
    const connection = native.connectionConfig(file)
    assert.deepEqual(Object.keys(connection), ['default_model', 'providers'])
    const parsed = toml.parse(native.renderConfig({ connection, systemPrompt: 'owned prompt', targetPath: path.join(root, 'target'), scratchPath: path.join(root, 'scratch'), readOnly: true }))
    assert.equal(parsed.agent.system_prompt, 'owned prompt')
    assert.equal(parsed.sandbox.workspace_root, path.join(root, 'scratch'))
    assert.equal(parsed.sandbox.bash, 'enforce')
    assert.equal(parsed.sandbox.network, false)
    assert.equal(parsed.skills.disable_implicit_invocation, true)
    assert.equal(parsed.telemetry.cli_metrics, 'off')
    assert.equal(parsed.secrets.filter_subprocess_env, true)
    assert.equal(parsed.hooks, undefined)
    assert.ok(parsed.permissions.deny.includes('task'))
    assert.ok(parsed.permissions.deny.includes('write_file'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('native stream preserves observed commands, session identity and exact usage', () => {
  const observed = []
  const stream = new ReasonixEventStream({ onUsageDelta: delta => { observed.push(delta); return { continue: true } } })
  const push = value => stream.push(JSON.stringify(value))
  push({ kind: 'tool_dispatch', tool: { id: 'tool-1', name: 'bash', args: JSON.stringify({ command: 'node --test' }), readOnly: true } })
  push({ kind: 'tool_result', tool: { id: 'tool-1', name: 'bash', args: JSON.stringify({ command: 'node --test' }), readOnly: true, output: 'tests 1\npass 1\nfail 0', execution: { exitCode: 0 } } })
  push({ kind: 'usage', usage: { promptTokens: 12, cacheHitTokens: 8, completionTokens: 6, reasoningTokens: 2 } })
  push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-session', result: '{"ok":true}', usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 8 } })
  const result = stream.finish()
  assert.equal(result.sessionId, 'native-session')
  assert.deepEqual(result.output, { ok: true })
  assert.deepEqual(result.usage, { noncachedInput: 4, cachedInput: 8, output: 6, reasoning: 2 })
  assert.equal(result.activeWorkSettled, true)
  assert.deepEqual(observed, [result.usage])
})

test('native stream never promotes provisional text, unfinished tools, or estimated accounting', () => {
  const stream = new ReasonixEventStream()
  stream.push(JSON.stringify({ kind: 'message', text: '{"ok":true}' }))
  assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
  assert.throws(() => native.nativeUsage({ promptTokens: 10, cacheHitTokens: 0, completionTokens: 1, estimated: true }), { code: 'PROVIDER_USAGE_UNKNOWN' })
  assert.throws(() => native.nativeUsage({ promptTokens: 10, cacheHitTokens: 11, completionTokens: 1 }), { code: 'PROVIDER_USAGE_UNKNOWN' })
  stream.push(JSON.stringify({ kind: 'tool_dispatch', tool: { id: 'open', name: 'bash', args: '{}', readOnly: true } }))
  assert.throws(() => stream.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'x', result: '{}' })), { code: 'CHILD_RUNTIME_FAILURE' })
})

test('Reasonix lifecycle verifies a private closure, rejects tampering and preserves unrelated files', () => {
  const packaging = require('../../scripts/reasonix-package.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-lifecycle-'))
  try {
    fs.writeFileSync(path.join(root, 'config.toml'), 'default_model = "personal"\n')
    const first = packaging.install(root)
    assert.equal(first.contractVersion, '2.0.0')
    for (const name of ['tool-boundary', 'tool-server', 'controlled-tools']) {
      assert.match(first.files[`scripts/harness-v2-${name}.cjs`], /^[a-f0-9]{64}$/)
    }
    // Resolve the installed closure itself; checkout dependencies must not mask
    // a missing runtime module after installation.
    const installedTransport = require(path.join(first.bundle, 'agents/reasonix/workflow/transport.js'))
    const installedControlled = require(path.join(first.bundle, 'scripts/harness-v2-controlled-tools.cjs'))
    assert.equal(typeof installedTransport.ReasonixExecAdapter, 'function')
    assert.equal(installedControlled.toolName('reasonix', 'read'), 'mcp__autoprompt_owned__read')
    assert.equal(packaging.install(root).payloadDigest, first.payloadDigest)
    assert.equal(fs.existsSync(path.join(root, 'skills/ap-worker/SKILL.md')), false)
    assert.equal(fs.readFileSync(path.join(root, 'skills/autoprompt/SKILL.md'), 'utf8'), packaging.launcher(root))
    const { verifyAdmission } = require('../../agents/reasonix/workflow/admission.js')
    assert.throws(() => verifyAdmission(first, { sha256: 'a'.repeat(64), version: '1.30.0' }), { code: 'PROVIDER_UNSUPPORTED' })
    const metadata = path.join(first.bundle, 'package.json')
    const original = fs.readFileSync(metadata)
    fs.writeFileSync(metadata, '{"type":"module"}')
    assert.throws(() => packaging.verify(root), { code: 'PAYLOAD_INVALID' })
    assert.throws(() => packaging.uninstall(root), { code: 'PAYLOAD_INVALID' })
    fs.writeFileSync(metadata, original)
    packaging.uninstall(root)
    assert.equal(fs.readFileSync(path.join(root, 'config.toml'), 'utf8'), 'default_model = "personal"\n')
    assert.equal(fs.existsSync(path.join(root, 'skills/autoprompt/SKILL.md')), false)
    assert.equal(packaging.uninstall(root).status, 'not-installed')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('installation refuses linked private ancestors before writing outside the root', { skip: process.platform === 'win32' }, () => {
  const packaging = require('../../scripts/reasonix-package.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-linked-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-outside-'))
  try {
    fs.symlinkSync(outside, path.join(root, '.autoprompt-private'))
    assert.throws(() => packaging.install(root))
    assert.deepEqual(fs.readdirSync(outside), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

test('native partial and refreshed tool events are one observed call; inconsistent final usage is refused', () => {
  let calls = 0
  const stream = new ReasonixEventStream({ onToolCallObserved: () => calls++ })
  for (const tool of [
    { id: 'one', name: 'bash', partial: true },
    { id: 'one', name: 'bash', args: '{"command":"echo checked"}' },
    { id: 'one', name: 'bash', args: '{"command":"echo checked"}', refreshed: true },
  ]) stream.push(JSON.stringify({ kind: 'tool_dispatch', tool }))
  stream.push(JSON.stringify({ kind: 'tool_result', tool: { id: 'one', name: 'bash', args: '{"command":"echo checked"}', readOnly: true, output: 'checked\n', execution: { exitCode: 0 } } }))
  assert.equal(calls, 1)
  stream.push(JSON.stringify({ kind: 'usage', usage: { promptTokens: 10, cacheHitTokens: 0, completionTokens: 2 } }))
  assert.throws(() => stream.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'one', result: '{}', usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 0 } })), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('model selection preserves inheritance and pins and refuses unmeasured automatic casting', () => {
  const { validateSelection, resolveAssignment } = require('../../scripts/reasonix-configure.cjs')
  const inherited = validateSelection({ mode: 'provider-default', selector: 'off', models: [] })
  assert.equal(resolveAssignment(inherited, {}).model, null)
  const pinned = { mode: 'explicit', selector: 'provider/model', models: ['provider/model'], effort: 'high' }
  assert.deepEqual(resolveAssignment(pinned, { logicalRole: 'worker' }), resolveAssignment(pinned, { logicalRole: 'route-analyst' }))
  assert.throws(() => validateSelection({ mode: 'automatic', selector: 'auto', models: [] }), { code: 'MODEL_REGISTRY_RECEIPT_INVALID' })
  assert.throws(() => validateSelection({ ...inherited, effort: 'high' }), { code: 'INVALID_INPUT' })
})

test('public CLI and POSIX lifecycle share the private v2 receipt', { skip: process.platform === 'win32', timeout: 60000 }, () => {
  const cp = require('node:child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-shell-'))
  const repo = path.resolve(__dirname, '../..')
  const destination = path.join(root, 'installation')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'reasonix'), '#!/bin/sh\nprintf "reasonix v1.30.0\\n"\n', { mode: 0o755 })
  const env = { ...process.env, AUTOPROMPT_INSTALL_ROOT: destination, REASONIX_HOME: destination, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) }
  const run = (script, args = []) => cp.spawnSync('bash', [path.join(repo, 'scripts/install', `${script}.sh`), ...args], { env, encoding: 'utf8', timeout: 30000 })
  try {
    const installed = run('install', ['reasonix'])
    assert.equal(installed.status, 0, installed.stdout + installed.stderr)
    const receipt = require('../../scripts/reasonix-package.cjs').verify(destination)
    assert.equal(receipt.contractVersion, '2.0.0')
    const doctor = run('doctor', ['reasonix', '--strict'])
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr)
    const cli = cp.spawnSync(process.execPath, [path.join(repo, 'bin/autoprompt.cjs'), 'doctor', 'reasonix', '--root', destination], { env, encoding: 'utf8' })
    assert.equal(cli.status, 0, cli.stdout + cli.stderr)
    const removed = run('uninstall', ['reasonix'])
    assert.equal(removed.status, 0, removed.stdout + removed.stderr)
    assert.equal(fs.existsSync(path.join(destination, '.autoprompt-reasonix-v2.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('byte-matched v1 profiles migrate into quarantine while custom skills survive', () => {
  const packaging = require('../../scripts/reasonix-package.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-migrate-'))
  try {
    for (const name of ['SKILL.md', 'skills/ap-manager/SKILL.md']) {
      const content = fs.readFileSync(path.join(__dirname, '../fixtures/reasonix-v1', name === 'SKILL.md' ? 'SKILL.md' : 'ap-manager.md'), 'utf8')
      assert.ok(content)
      const destination = path.join(root, name === 'SKILL.md' ? 'skills/autoprompt/SKILL.md' : name)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, content)
    }
    const notes = path.join(root, 'skills/ap-manager/notes.txt')
    fs.writeFileSync(notes, 'personal notes')
    packaging.install(root)
    assert.equal(fs.existsSync(path.join(root, 'skills/ap-manager/SKILL.md')), false)
    assert.equal(fs.readFileSync(notes, 'utf8'), 'personal notes')
    assert.ok(fs.existsSync(path.join(root, '.autoprompt-private/legacy-v1/skills/ap-manager/SKILL.md')))
    packaging.uninstall(root)
    assert.equal(fs.readFileSync(notes, 'utf8'), 'personal notes')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed v1 migration restores roles and entry skill and can be retried', t => {
  const packaging = require('../../scripts/reasonix-package.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-rollback-'))
  const originals = new Map()
  try {
    for (const [relative, fixture] of [
      ['skills/autoprompt/SKILL.md', 'SKILL.md'],
      ['skills/ap-manager/SKILL.md', 'ap-manager.md'],
    ]) {
      const file = path.join(root, relative)
      const bytes = fs.readFileSync(path.join(__dirname, '../fixtures/reasonix-v1', fixture))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
      originals.set(file, bytes)
    }
    const rename = fs.renameSync
    const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === path.join(root, packaging.RECEIPT)) throw Object.assign(new Error('simulated receipt write failure'), { code: 'EIO' })
      return rename(from, to)
    })
    assert.throws(() => packaging.install(root), { code: 'EIO' })
    mocked.mock.restore()
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes)
    assert.equal(fs.existsSync(path.join(root, packaging.RECEIPT)), false)
    assert.deepEqual(fs.readdirSync(path.join(root, '.autoprompt-private/bundles')), [])
    assert.equal(fs.readdirSync(root).some(file => file.includes('.tmp-')), false)
    const installed = packaging.install(root)
    assert.equal(Object.keys(installed.files).filter(file => /^agents\/reasonix\/skills\/[^/]+\/SKILL\.md$/.test(file)).length, 32)
    packaging.uninstall(root)
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed bundle staging leaves no partial installation and allows retry', t => {
  const packaging = require('../../scripts/reasonix-package.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-stage-rollback-'))
  try {
    const write = fs.writeFileSync
    const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      if (String(file).includes('.stage-') && String(file).endsWith('agents/reasonix/SKILL.md')) throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' })
      return write(file, ...args)
    })
    assert.throws(() => packaging.install(root), { code: 'ENOSPC' })
    mocked.mock.restore()
    assert.deepEqual(fs.readdirSync(path.join(root, '.autoprompt-private/bundles')), [])
    assert.equal(fs.existsSync(path.join(root, packaging.RECEIPT)), false)
    assert.equal(fs.existsSync(path.join(root, 'skills/autoprompt/SKILL.md')), false)
    packaging.install(root)
    packaging.uninstall(root)
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('public installer reports a failed Reasonix installation through its exit status', { skip: process.platform === 'win32' }, () => {
  const cp = require('node:child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-failed-install-'))
  try {
    const bin = path.join(root, 'bin')
    const destination = path.join(root, 'installation')
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(destination, 'skills/autoprompt'), { recursive: true })
    fs.writeFileSync(path.join(destination, 'skills/autoprompt/SKILL.md'), 'custom skill that must survive')
    fs.writeFileSync(path.join(bin, 'reasonix'), '#!/bin/sh\nprintf "reasonix v1.30.0\\n"\n', { mode: 0o755 })
    const result = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../../bin/autoprompt.cjs'), 'install', 'reasonix', '--root', destination], {
      env: { ...process.env, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) }, encoding: 'utf8', timeout: 30000,
    })
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /FAIL\s+reasonix\s+stage=lifecycle/)
    assert.equal(fs.readFileSync(path.join(destination, 'skills/autoprompt/SKILL.md'), 'utf8'), 'custom skill that must survive')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed upgrade verification restores the previous receipt and working bundle', t => {
  const packaging = require('../../scripts/reasonix-package.cjs')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-upgrade-rollback-'))
  const root = path.join(temporary, 'installation')
  const source = path.join(temporary, 'source')
  try {
    const previous = packaging.install(root)
    const receiptBytes = fs.readFileSync(path.join(root, packaging.RECEIPT))
    for (const file of Object.keys(packaging.sourceInventory().files)) {
      const destination = path.join(source, file)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(path.join(packaging.ROOT, file), destination)
    }
    fs.appendFileSync(path.join(source, 'agents/reasonix/README.md'), '\nUpdated release fixture.\n')
    const rename = fs.renameSync
    const readdir = fs.readdirSync
    let receiptPublished = false
    let failed = false
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = rename(from, to)
      if (to === path.join(root, packaging.RECEIPT)) receiptPublished = true
      return result
    })
    t.mock.method(fs, 'readdirSync', (directory, ...args) => {
      if (receiptPublished && !failed && String(directory).startsWith(path.join(root, '.autoprompt-private/bundles'))) {
        failed = true
        throw Object.assign(new Error('simulated verification read failure'), { code: 'EIO' })
      }
      return readdir(directory, ...args)
    })
    assert.throws(() => packaging.install(root, source), { code: 'EIO' })
    t.mock.restoreAll()
    assert.deepEqual(fs.readFileSync(path.join(root, packaging.RECEIPT)), receiptBytes)
    assert.equal(packaging.verify(root).payloadDigest, previous.payloadDigest)
    assert.deepEqual(fs.readdirSync(path.join(root, '.autoprompt-private/bundles')), [previous.payloadGeneration])
    const updated = packaging.install(root, source)
    assert.notEqual(updated.payloadDigest, previous.payloadDigest)
    assert.equal(fs.existsSync(previous.bundle), false)
    packaging.uninstall(root)
  } finally { t.mock.restoreAll(); fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('repair launches retain the original native state root across new controller launch identities', () => {
  const { nativeContextRoot, persistNativeContext } = require('../../agents/reasonix/workflow/transport.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-context-'))
  try {
    const first = { sessionId: 'controller-launch-1', providerRole: 'ap-worker' }
    const target = path.join(root, 'workspace')
    const state = nativeContextRoot(root, first, target)
    persistNativeContext(root, state, first, target, 'native-session-1')
    const repair = { ...first, sessionId: 'controller-launch-2', continuationId: 'native-session-1' }
    assert.equal(nativeContextRoot(root, repair, target), state)
    assert.throws(() => nativeContextRoot(root, { ...repair, providerRole: 'ap-independent-checker' }, target), { code: 'SESSION_ID_MISMATCH' })
    assert.throws(() => nativeContextRoot(root, repair, path.join(root, 'other')), { code: 'SESSION_ID_MISMATCH' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a declarative Reasonix profile cannot forge an enforced safety channel', () => {
  const cp = require('node:child_process')
  const safety = require('../../scripts/local-only-safety.cjs')
  const { PROFILE } = require('../../scripts/reasonix-configure.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-proof-'))
  const target = path.join(root, 'target')
  try {
    cp.execFileSync('git', ['init', '-q', '-b', 'main', target])
    cp.execFileSync('git', ['-C', target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'fixture'])
    const profilePath = path.join(root, 'profile.json')
    fs.writeFileSync(profilePath, JSON.stringify(PROFILE), { mode: 0o600 })
    const proof = { provider: 'reasonix', schemaVersion: 1, profilePath, profileSha256: native.sha256(fs.readFileSync(profilePath)) }
    const inspected = safety.inspect(safety.discoverRepository(target), 'main', process.env, { enforcementProof: proof })
    assert.equal(inspected.channels.providerConnectorApiWriteToolDenial.enforced, false)
    assert.equal(inspected.mechanicallyEnforced, false)
    assert.ok(inspected.residuals.some(item => item.code === 'ENFORCEMENT_PROOF_INVALID'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
