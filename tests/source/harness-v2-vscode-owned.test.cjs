'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { usageReceipt } = require('../../scripts/harness-v2-bridge/vscode/owned-session.cjs')
const { sanitize } = require('../../scripts/harness-v2-vscode-config.cjs')
const native = require('../../scripts/harness-v2-native.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')

test('owned VS Code usage retains exact billed categories and rejects inconsistent receipts', () => {
  const source = { id: 'request-1', model: 'fixture', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } }
  const receipt = usageReceipt(source)
  assert.deepEqual(receipt.usage, { input: 9, cacheRead: 3, cacheWrite: 0, output: 5, reasoning: 2, totalTokens: 17 })
  for (const usage of [{}, { ...source.usage, total_tokens: 18 }, { ...source.usage, prompt_tokens: 1.5 }, { ...source.usage, completion_tokens_details: { reasoning_tokens: 6 } }, { ...source.usage, prompt_tokens_details: { cached_tokens: 13 } }]) {
    assert.throws(() => usageReceipt({ ...source, usage }), { code: 'PROVIDER_USAGE_UNKNOWN' })
  }
  const stream = new HarnessEventStream('vscode')
  stream.push(JSON.stringify({ type: 'owned.session', sessionId: 'vscode-owned-test', contextKind: 'autoprompt-extension' }))
  stream.push(JSON.stringify({ type: 'owned.usage', ...receipt }))
  stream.push(JSON.stringify({ type: 'owned.result', output: { ok: true } }))
  assert.deepEqual(stream.finish().usage, { noncachedInput: 9, cachedInput: 3, output: 5, reasoning: 2 })
})

test('owned VS Code connection cannot silently load executable providers or unsafe endpoints', () => {
  const connection = sanitize({ model: 'test', ignoredExecutable: '/tmp/untrusted', maxTokens: 64 })
  assert.equal(connection.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(connection.ignoredExecutable, undefined)
  for (const value of [{ baseUrl: 'http://example.com/v1' }, { baseUrl: 'https://user:secret@example.com/v1' }, { apiKeyEnv: 'PATH' }, { maxSteps: 129 }, { maxTokens: -1 }, { timeoutMs: Infinity }, { reasoningEffort: 'invented' }]) {
    assert.throws(() => sanitize(value), { code: 'PROFILE_INVALID' })
  }
})

test('owned VS Code stream never accepts built-in chat identities, foreign tools or duplicate billing', () => {
  assert.throws(() => new HarnessEventStream('vscode').push(JSON.stringify({ type: 'owned.session', sessionId: 'built-in', contextKind: 'vscode-chat' })), { code: 'SESSION_ID_MISMATCH' })
  const stream = new HarnessEventStream('vscode')
  const usage = { type: 'owned.usage', requestId: 'same', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0, totalTokens: 2 } }
  stream.push(JSON.stringify(usage))
  assert.throws(() => stream.push(JSON.stringify(usage)), { code: 'PROVIDER_USAGE_UNKNOWN' })
  assert.throws(() => new HarnessEventStream('vscode').push(JSON.stringify({ type: 'owned.tool.start', id: 'agent', name: 'runSubagent', args: {} })), { code: 'ROLE_POLICY_DENIED' })
})

test('owned VS Code reasoning effort uses the explicit provider field without invented aliases', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) assert.equal(native.validateEffort('vscode', effort), effort)
  for (const effort of ['max', 'off', true, 3]) assert.throws(() => native.validateEffort('vscode', effort), { code: 'PROFILE_INVALID' })
})

test('VS Code runtime identity binds application files even when Electron stays unchanged', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'resources/app')
  fs.mkdirSync(path.join(app, 'out'), { recursive: true })
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"code"}')
  fs.writeFileSync(path.join(app, 'product.json'), '{"applicationName":"code"}')
  const executable = path.join(root, 'code'); fs.writeFileSync(executable, 'unchanged native executable')
  fs.writeFileSync(path.join(app, 'out/main.js'), 'version one')
  const before = native.runtimeDependencyIdentity(executable)
  fs.writeFileSync(path.join(app, 'out/main.js'), 'version two')
  const after = native.runtimeDependencyIdentity(executable)
  assert.notEqual(before.sha256, after.sha256)
  assert.equal(before.fileCount, 4)
})
