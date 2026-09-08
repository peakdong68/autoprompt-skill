'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const { HarnessEventStream, exactUsage, contextRoot, persistContext } = require('../../scripts/harness-v2-transport.cjs')
const { ReasonixEventStream } = require('../../agents/reasonix/workflow/transport.js')
const PROVIDERS = ['claude', 'opencode', 'kilo', 'prime', 'omp']
const expected = { noncachedInput: 13, cachedInput: 2, output: 4, reasoning: 1 }
function usage(provider) {
  if (provider === 'claude') return { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1 }
  if (['opencode', 'kilo'].includes(provider)) return { input: 10, cache: { read: 2, write: 3 }, output: 3, reasoning: 1 }
  return { input: 10, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1, totalTokens: 19 }
}
// Wire fixtures test the adapter, not a provider binary or live-model conformance.
function events(provider, text = '{"ok":true}') {
  const session = 'session-fixture-1'
  if (provider === 'claude') return [
    { type: 'system', subtype: 'init', session_id: session },
    { type: 'stream_event', session_id: session, event: { type: 'message_start', message: {
      role: 'assistant', id: 'request-1', usage: { ...usage(provider), output_tokens: 0, reasoning_output_tokens: 0 },
    } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'stream_event', session_id: session, event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', session_id: session, event: { type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 4, reasoning_output_tokens: 1 } } },
    { type: 'stream_event', session_id: session, event: { type: 'message_stop' } },
    { type: 'assistant', session_id: session, message: { role: 'assistant', id: 'request-1', usage: usage(provider), content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, usage: usage(provider), result: text },
  ]
  if (['opencode', 'kilo'].includes(provider)) {
    const base = { sessionID: session, messageID: 'request-1' }
    return [
      { type: 'step_start', sessionID: session, part: { ...base, id: 'start-1', type: 'step-start' } },
      { type: 'text', sessionID: session, part: { ...base, id: 'text-1', type: 'text', text, time: { end: 2 } } },
      { type: 'step_finish', sessionID: session, part: { ...base, id: 'finish-1', type: 'step-finish', reason: 'stop', tokens: usage(provider) } },
    ]
  }
  const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: usage(provider) }
  return [{ type: 'session', id: session }, { type: 'agent_start' }, { type: 'turn_start' },
    { type: 'message_end', message }, { type: 'turn_end', message }, { type: 'agent_end', messages: [message] }]
}
function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-native-unit-'))
  t.after(() => fs.rmSync(value, { recursive: true, force: true }))
  return value
}
function pushAll(stream, records) { for (const event of records) stream.push(JSON.stringify(event)); return stream.finish() }

test('OMP completion-time decoration does not hide changed message content or usage', () => {
  const decorated = events('omp').map(event => structuredClone(event))
  decorated[3] = { ...decorated[3], message: { ...decorated[3].message, completedAt: 1788816247866 } }
  assert.deepEqual(pushAll(new HarnessEventStream('omp'), decorated).output, { ok: true })
  for (const change of [
    message => { message.content[0].text = '{"ok":false}' },
    message => { message.usage.input++ },
    message => { message.stopReason = 'toolUse' },
    message => { message.provider = 'different-provider' },
  ]) {
    const changed = structuredClone(decorated)
    change(changed[4].message)
    assert.throws(() => pushAll(new HarnessEventStream('omp'), changed), { code: 'TRANSPORT_INVALID' })
  }
  decorated[3].message.completedAt = 'not-a-timestamp'
  assert.throws(() => pushAll(new HarnessEventStream('omp'), decorated), { code: 'TRANSPORT_INVALID' })
})

for (const provider of PROVIDERS) {
  test(`${provider}: complete native wire retains exact usage, session, output and hashes`, () => {
    const debits = [], observed = []
    const stream = new HarnessEventStream(provider, { onUsageDelta: delta => { debits.push(delta); return { continue: true } }, onEvent: e => observed.push(e) })
    const parsed = pushAll(stream, events(provider))
    assert.deepEqual(parsed.output, { ok: true })
    assert.deepEqual(parsed.usage, expected)
    assert.equal(parsed.sessionId, 'session-fixture-1')
    assert.equal(parsed.activeWorkSettled, true)
    assert.deepEqual(debits, [expected])
    assert.equal(observed.length, events(provider).length)
    assert.match(parsed.rawOutputHash, /^[a-f0-9]{64}$/)
    assert.match(parsed.eventStreamHash, /^[a-f0-9]{64}$/)
    assert.throws(() => stream.push(JSON.stringify(events(provider)[0])), { code: 'TRANSPORT_INVALID' })
  })
  test(`${provider}: a denied or missing budget verdict stops with already-observed usage`, () => {
    for (const verdict of [{ continue: false }, undefined, false, { continue: 1 }]) {
      const stream = new HarnessEventStream(provider, { onUsageDelta: () => verdict })
      assert.throws(() => pushAll(stream, events(provider)), error => {
        assert.equal(error.code, 'BUDGET_EXHAUSTED')
        assert.deepEqual(error.usage, expected)
        return true
      })
      assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
    }
  })
  test(`${provider}: a result cannot conceal unfinished tools or a different continuation`, () => {
    const incomplete = new HarnessEventStream(provider)
    incomplete.startTool('read-1', 'Read', { file_path: '/fixture' })
    assert.throws(() => pushAll(incomplete, events(provider)))
    const mismatch = new HarnessEventStream(provider, { continuationId: 'different-session' })
    assert.throws(() => mismatch.push(JSON.stringify(events(provider)[0])), { code: 'SESSION_ID_MISMATCH' })
    for (const text of ['not JSON', '[]', 'true', '{} trailing text']) {
      assert.throws(() => pushAll(new HarnessEventStream(provider), events(provider, text)), { code: 'CHILD_RESULT_INVALID' })
    }
  })
  test(`${provider}: tool authority and complete command output are enforced separately from prose`, () => {
    const readonly = new HarnessEventStream(provider, { readOnly: true })
    for (const name of ['Write', 'Edit', 'Agent', 'Task', 'Skill', 'subagent', 'bash']) {
      assert.throws(() => readonly.startTool('denied', name, { command: 'echo not-run' }), { code: 'ROLE_POLICY_DENIED' })
    }
    const command = new HarnessEventStream(provider, { commandBoundary: true })
    command.startTool('command-1', 'bash', { command: 'printf fixture' })
    assert.throws(() => command.finishTool('command-1', 'fixture'), { code: 'TOOL_OUTPUT_INCOMPLETE' })
    assert.throws(() => command.finishTool('command-1', 'fixture', { exitCode: 0, truncated: true }), { code: 'TOOL_OUTPUT_INCOMPLETE' })
    command.finishTool('command-1', 'fixture', { exitCode: 0 })
    assert.throws(() => command.startTool('command-1', 'Read', {}), { code: 'TRANSPORT_INVALID' })
    assert.deepEqual(pushAll(command, events(provider)).output, { ok: true })
  })
  test(`${provider}: missing, estimated, negative and inconsistent native billing are refused`, () => {
    assert.deepEqual(exactUsage(provider, usage(provider)), expected)
    for (const value of [null, {}, { ...usage(provider), estimated: true }, { ...usage(provider), isEstimated: true }, { ...usage(provider), source: 'estimated' }]) {
      assert.throws(() => exactUsage(provider, value), { code: 'PROVIDER_USAGE_UNKNOWN' })
    }
    const invalid = usage(provider)
    invalid[provider === 'claude' ? 'output_tokens' : 'output'] = -1
    assert.throws(() => exactUsage(provider, invalid), { code: 'PROVIDER_USAGE_UNKNOWN' })
  })
}

test('Claude charges only its final authoritative usage receipt', () => {
  let debits = 0
  const stream = new HarnessEventStream('claude', { onUsageDelta: () => ({ continue: ++debits > 1 }) })
  assert.throws(() => pushAll(stream, events('claude')), error => {
    assert.equal(error.code, 'BUDGET_EXHAUSTED'); assert.deepEqual(error.usage, expected); return true
  })
  assert.equal(debits, 1)
  assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
})

test('Claude thinking progress neither changes billing nor permits native delegation', () => {
  const transcript = events('claude')
  transcript.splice(1, 0, { type: 'system', subtype: 'thinking_tokens', thinking_tokens: 9000 })
  assert.deepEqual(pushAll(new HarnessEventStream('claude'), transcript).usage, expected)
  const stream = new HarnessEventStream('claude')
  assert.throws(() => stream.push(JSON.stringify({ type: 'system', subtype: 'thinking_tokens',
    parent_tool_use_id: 'native-child' })), { code: 'ROLE_POLICY_DENIED' })
})

test('Claude refuses unstreamed assistant accounting and unfinished streamed content', () => {
  const missing = events('claude').filter(event => event.type !== 'stream_event')
  assert.throws(() => pushAll(new HarnessEventStream('claude'), missing), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const unfinished = events('claude').filter(event => event.event?.type !== 'content_block_stop')
  assert.throws(() => pushAll(new HarnessEventStream('claude'), unfinished), { code: 'CHILD_RUNTIME_FAILURE' })
  const lied = events('claude')
  lied.find(event => event.type === 'assistant').message.usage.input_tokens++
  assert.throws(() => pushAll(new HarnessEventStream('claude'), lied), { code: 'PROVIDER_USAGE_UNKNOWN' })
})

test('Claude accepts provisional streamed usage but requires a complete final receipt', () => {
  const partial = events('claude')
  const start = partial.find(event => event.event?.type === 'message_start').event.message.usage
  delete start.cache_creation_input_tokens
  partial.find(event => event.type === 'assistant').message.usage = { ...start }
  const parsed = pushAll(new HarnessEventStream('claude'), partial)
  assert.deepEqual(parsed.usage, expected)
  const missingFinal = events('claude')
  delete missingFinal.find(event => event.type === 'result').usage.cache_creation_input_tokens
  assert.throws(() => pushAll(new HarnessEventStream('claude'), missingFinal), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const contradictory = events('claude')
  contradictory.find(event => event.type === 'result').usage.input_tokens++
  assert.throws(() => pushAll(new HarnessEventStream('claude'), contradictory), { code: 'PROVIDER_USAGE_UNKNOWN' })
  const noReceipt = events('claude').filter(event => event.type !== 'result')
  assert.throws(() => pushAll(new HarnessEventStream('claude'), noReceipt), { code: 'CHILD_RESULT_MISSING' })
})

test('Reasonix also obeys the scheduler token stop and retains the consumed usage', () => {
  for (const verdict of [{ continue: false }, undefined]) {
    const stream = new ReasonixEventStream({ onUsageDelta: () => verdict })
    assert.throws(() => stream.push(JSON.stringify({ kind: 'usage', usage: { promptTokens: 10, cacheHitTokens: 2, completionTokens: 4, reasoningTokens: 1 } })), error => {
      assert.equal(error.code, 'BUDGET_EXHAUSTED')
      assert.deepEqual(error.usage, { noncachedInput: 8, cachedInput: 2, output: 4, reasoning: 1 }); return true
    })
    assert.throws(() => stream.finish(), { code: 'CHILD_RESULT_MISSING' })
  }
})

test('provider lookup rejects inherited object properties and non-provider transports', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'codex', '', null, {}]) assert.throws(() => native.descriptor(id), { code: 'PROVIDER_UNSUPPORTED' })
  const owned = new HarnessEventStream('vscode')
  assert.equal(owned.protocol, 'vscode-owned-json')
  assert.throws(() => owned.finish(), { code: 'CHILD_RESULT_MISSING' })
  assert.deepEqual(native.descriptor('vscode').blockers, [])
})

test('Prime native ownership path is pinned to the exact release that exposes the verified owned worker', () => {
  const descriptor = native.descriptor('prime')
  assert.deepEqual(descriptor.versions, ['0.7.2'])
  const help = descriptor.flags.join(' ')
  const spawnSync = (_file, argv) => argv[0] === '--version'
    ? { status: 0, signal: null, stdout: 'prime-agent 0.7.3\n', stderr: '' }
    : { status: 0, signal: null, stdout: help, stderr: '' }
  assert.throws(() => native.probeExecutable({ provider: 'prime', executable: process.execPath, spawnSync }), error => {
    assert.equal(error.code, 'PROVIDER_UNSUPPORTED')
    assert.deepEqual(error.details.supportedVersions, ['0.7.2'])
    return true
  })
})

test('native connection extraction excludes executable plugins and prototype-bearing records', () => {
  const connection = native.sanitizeConnection('opencode', { model: 'local/fixture', hooks: ['foreign'], plugin: ['foreign'],
    providers: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'fixture' }, models: { fixture: { name: 'Fixture' } } } } })
  assert.equal(connection.model, 'local/fixture'); assert.equal(connection.hooks, undefined); assert.equal(connection.plugin, undefined)
  for (const source of [null, [], { providers: [] }, { providers: { local: { npm: 'untrusted-executable-provider' } } },
    JSON.parse('{"providers":{"__proto__":{"polluted":true}}}'), { providers: { local: { models: { fixture: null } } } },
    { providers: { local: { models: JSON.parse('{"constructor":{}}') } } }]) {
    assert.throws(() => native.sanitizeConnection('opencode', source), { code: 'PROFILE_INVALID' })
  }
  assert.equal({}.polluted, undefined)
})

test('OpenCode and Kilo use only declared reasoning variants for custom provider models', t => {
  const directory = root(t)
  for (const provider of ['opencode', 'kilo']) {
    const connection = { model: 'local/fixture', providers: { local: { npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: '<local-test-only>' }, models: { fixture: {
        name: 'Fixture', variants: { high: { reasoningEffort: 'high' } },
      } } } } }
    const launch = native.createLaunch({ provider, home: path.join(directory, provider), sessionRoot: path.join(directory, 'session'),
      targetPath: directory, cwd: directory, prompt: 'fixture', input: 'fixture', connection, effort: 'high', environment: { PATH: process.env.PATH } })
    assert.ok(launch.argv.includes('--variant'))
    assert.equal(launch.argv[launch.argv.indexOf('--variant') + 1], 'high')
    assert.deepEqual(native.sanitizeConnection(provider, connection).providers.local.models.fixture.variants,
      { high: { reasoningEffort: 'high' } })
    assert.throws(() => native.createLaunch({ provider, home: path.join(directory, `${provider}-missing`), sessionRoot: path.join(directory, 'session'),
      targetPath: directory, cwd: directory, prompt: 'fixture', input: 'fixture', connection: { ...connection, providers: { local: { ...connection.providers.local,
        models: { fixture: { name: 'Fixture' } } } } }, effort: 'high', environment: { PATH: process.env.PATH } }), { code: 'PROFILE_INVALID' })
  }
})

test('private child environment strips code injection, foreign config and unrelated credentials', t => {
  const home = root(t)
  const result = native.isolatedEnvironment(home, { PATH: process.env.PATH, NODE_OPTIONS: '--require foreign.js', LD_PRELOAD: '/foreign',
    OPENCODE_CONFIG: '/foreign', ANTHROPIC_API_KEY: 'unrelated', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'push.default', GIT_CONFIG_VALUE_0: 'nothing' })
  for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'OPENCODE_CONFIG', 'ANTHROPIC_API_KEY']) assert.equal(result[key], undefined)
  assert.equal(result.HOME, home); assert.equal(result.GIT_CONFIG_VALUE_0, 'nothing')
  assert.equal(fs.readFileSync(result.GIT_CONFIG_GLOBAL, 'utf8'), '')
})

test('native continuation is exact across new launch identities and refuses role/workspace/provider changes', t => {
  const directory = root(t), target = path.join(directory, 'target')
  const first = { sessionId: 'launch-1', providerRole: 'ap-worker' }
  const saved = contextRoot(directory, 'claude', first, target)
  persistContext(directory, saved, 'claude', first, target, 'native-1')
  const resumed = { ...first, sessionId: 'launch-2', continuationId: 'native-1' }
  assert.equal(contextRoot(directory, 'claude', resumed, target), saved)
  for (const [provider, record, workspace] of [['kilo', resumed, target], ['claude', { ...resumed, providerRole: 'ap-independent-checker' }, target], ['claude', resumed, `${target}-other`]]) {
    assert.throws(() => contextRoot(directory, provider, record, workspace), { code: 'SESSION_ID_MISMATCH' })
  }
})

test('native executable hashing supports hard-linked distributions and detects byte changes', t => {
  const directory = root(t), first = path.join(directory, 'native'), linked = path.join(directory, 'native-link')
  fs.writeFileSync(first, 'fixture executable bytes'); fs.linkSync(first, linked)
  const hash = native.executableSha256(first)
  assert.equal(native.executableSha256(linked), hash)
  fs.writeFileSync(linked, 'changed fixture executable bytes')
  assert.notEqual(native.executableSha256(first), hash)
  assert.throws(() => native.readBound(first), { code: 'PAYLOAD_INVALID' })
})

test('runtime identity binds resolved dependencies and backing files without unrelated packages', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const main = path.join(root, 'node_modules', 'native-harness')
  const dependency = path.join(root, 'node_modules', 'engine')
  const unrelated = path.join(root, 'node_modules', 'unrelated')
  for (const directory of [main, dependency, unrelated]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(main, 'package.json'), JSON.stringify({ name: 'native-harness', dependencies: { engine: '1' } }))
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'engine' }))
  const executable = path.join(main, 'cli.js'), backing = path.join(dependency, 'runtime.js')
  fs.writeFileSync(executable, '#!/usr/bin/env node\nrequire("engine")\n')
  fs.writeFileSync(backing, 'module.exports = 1')
  const first = native.runtimeDependencyIdentity(executable)
  assert.equal(first.packageCount, 2)
  fs.writeFileSync(path.join(unrelated, 'anything.js'), 'unrelated mutable install')
  assert.deepEqual(native.runtimeDependencyIdentity(executable), first)
  fs.writeFileSync(backing, 'module.exports = 2')
  assert.notEqual(native.runtimeDependencyIdentity(executable).sha256, first.sha256)
  fs.rmSync(dependency, { recursive: true })
  assert.throws(() => native.runtimeDependencyIdentity(executable), { code: 'PROVIDER_IDENTITY_MISMATCH' })
})

test('OpenCode and Kilo native visible output is disjoint from reasoning and reconciles to total', () => {
  // Captured native OpenCode OpenRouter step, corroborated by getUsage in the
  // official v1.18.29 session/session.ts source: outputTokens - reasoningTokens.
  for (const provider of ['opencode', 'kilo']) {
    const actual = { total: 2895, input: 311, output: 7, reasoning: 17, cache: { read: 2560, write: 0 } }
    assert.deepEqual(exactUsage(provider, actual), { noncachedInput: 311, cachedInput: 2560, output: 24, reasoning: 17 })
    assert.throws(() => exactUsage(provider, { ...actual, total: 2878 }), { code: 'PROVIDER_USAGE_UNKNOWN' })
    assert.throws(() => exactUsage(provider, { ...actual, output: -1 }), { code: 'PROVIDER_USAGE_UNKNOWN' })
    assert.throws(() => exactUsage(provider, { ...actual, reasoning: undefined }), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
})
