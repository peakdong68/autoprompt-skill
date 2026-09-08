'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')

function root(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pi-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function connection() {
  return { modelProvider: 'gateway', model: 'local-model', providers: { gateway: {
    baseUrl: 'http://127.0.0.1:12345/v1', api: 'openai-completions', apiKey: 'COMPANY_GATEWAY_KEY',
    models: [{ id: 'local-model', name: 'Local model', reasoning: false, input: ['text'],
      contextWindow: 32768, maxTokens: 2048, compat: { supportsUsageInStreaming: true } }],
  } } }
}
for (const provider of ['prime', 'omp']) {
  test(`${provider} imports native array-shaped model data without executable configuration`, () => {
    const source = { ...connection(), extensions: ['untrusted.ts'], hooks: { beforeAgent: 'untrusted' } }
    source.providers.gateway.command = 'never execute'
    source.providers.gateway.npm = 'untrusted-plugin'
    const actual = native.sanitizeConnection(provider, source)
    assert.deepEqual(actual, { provider, environment: {}, ...connection() })
    assert.deepEqual(native.credentialEnvironment(provider, actual, null, {
      COMPANY_GATEWAY_KEY: 'private-fixture-key', NODE_OPTIONS: '--import=untrusted', OTHER_SECRET: 'must-not-pass',
    }), { COMPANY_GATEWAY_KEY: 'private-fixture-key' })
  })
  test(`${provider} rejects command credentials and malformed model registry data`, () => {
    for (const change of [
      source => { source.providers.gateway.apiKey = '!printf stolen' },
      source => { source.providers.gateway.headers = { Authorization: '!read-secret' } },
      source => { source.providers.gateway.baseUrl = 'https://name:secret@example.test/v1' },
      source => { source.providers.gateway.models = { 'local-model': {} } },
      source => { source.providers.gateway.models.push(source.providers.gateway.models[0]) },
      source => { source.providers.gateway.models[0].maxTokens = 0 },
      source => { source.providers.gateway.models[0].compat.supportsUsageInStreaming = 'yes' },
    ]) {
      const source = connection(); change(source)
      assert.throws(() => native.sanitizeConnection(provider, source), { code: 'PROFILE_INVALID' })
    }
    assert.throws(() => native.sanitizeConnection(provider, JSON.parse('{"providers":{"__proto__":{}}}')), { code: 'PROFILE_INVALID' })
  })
}

test('OMP imports its actual YAML registry while rejecting duplicate keys, custom tags and alias expansion', t => {
  const dir = root(t), file = path.join(dir, 'models.yml')
  fs.writeFileSync(file, 'providers:\n  gateway:\n    baseUrl: http://127.0.0.1:12345/v1\n    api: openai-completions\n    apiKey: COMPANY_GATEWAY_KEY\n    models:\n      - id: local-model\n        contextWindow: 32768\n')
  assert.equal(native.connectionConfig('omp', dir).providers.gateway.models[0].contextWindow, 32768)
  for (const invalid of [
    'providers: {}\nproviders: {}\n',
    'providers: !external/command {}\n',
    'a: &a [1, 2]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a]\nproviders: [*b, *b, *b, *b, *b, *b, *b, *b]\n',
  ]) {
    fs.writeFileSync(file, invalid)
    assert.throws(() => native.connectionConfig('omp', dir), { code: 'PROFILE_INVALID' })
  }
})

test('OMP production launch projects only its verified extension and bounded native registry', t => {
  const dir = root(t), target = path.join(dir, 'target'), scratch = path.join(dir, 'scratch'), control = path.join(dir, 'control')
  for (const location of [target, scratch, control]) fs.mkdirSync(location, { mode: 0o700 })
  const prepared = boundary.prepareBoundary({ provider: 'omp', root: control, policy: {
    sessionId: 'test-session', reservationId: 'test-reservation', targetPath: target, scratchPath: scratch,
    readableRoots: [target, scratch], writableRoots: [scratch], readOnly: true,
    commandBoundary: true, nestedDispatch: false, externalWrites: false,
  } })
  const spec = native.createLaunch({ provider: 'omp', home: path.join(dir, 'home'), sessionRoot: path.join(dir, 'session'),
    targetPath: target, cwd: path.join(dir, 'cwd'), prompt: 'Bounded assignment', input: 'Read only', connection: connection(),
    toolBoundary: prepared, readOnly: true, commandBoundary: true, credentials: { COMPANY_GATEWAY_KEY: 'fixture-key' },
    environment: { PATH: process.env.PATH, NODE_OPTIONS: '--import=untrusted' } })
  for (const flag of ['--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty', '--no-title', '--no-prewalk']) assert.ok(spec.argv.includes(flag), flag)
  assert.equal(spec.argv[spec.argv.indexOf('--extension') + 1], path.resolve(__dirname, '../../scripts/harness-v2-bridge/pi/omp.ts'))
  assert.equal(spec.argv[spec.argv.indexOf('--provider') + 1], 'gateway')
  assert.equal(spec.env.COMPANY_GATEWAY_KEY, 'fixture-key')
  assert.equal(spec.env.NODE_OPTIONS, undefined)
  assert.equal(spec.env.AUTOPROMPT_TOOL_POLICY_SHA256, prepared.policySha256)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spec.env.PI_CODING_AGENT_DIR, 'models.yml'))), { providers: connection().providers })
})

test('Prime production launch uses its owned worker with only the explicit controller extension', t => {
  const dir = root(t), target = path.join(dir, 'target'), scratch = path.join(dir, 'scratch'), control = path.join(dir, 'control')
  for (const location of [target, scratch, control]) fs.mkdirSync(location, { mode: 0o700 })
  const prepared = boundary.prepareBoundary({ provider: 'prime', root: control, policy: {
    sessionId: 'test-session', reservationId: 'test-reservation', targetPath: target, scratchPath: scratch,
    readableRoots: [target, scratch], writableRoots: [scratch], readOnly: true,
    commandBoundary: true, nestedDispatch: false, externalWrites: false,
  } })
  const spec = native.createLaunch({ provider: 'prime', home: path.join(dir, 'home'), sessionRoot: path.join(dir, 'session'),
    targetPath: target, cwd: path.join(dir, 'cwd'), prompt: 'Bounded assignment', input: 'Read only', connection: connection(),
    toolBoundary: prepared, readOnly: true, commandBoundary: true, credentials: { COMPANY_GATEWAY_KEY: 'fixture-key' },
    environment: { PATH: process.env.PATH, NODE_OPTIONS: '--import=untrusted' } })
  for (const flag of ['--no-builtin-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--offline']) {
    assert.ok(spec.argv.includes(flag), flag)
  }
  assert.equal(spec.argv.includes('--no-tools'), false)
  assert.equal(spec.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND, '1')
  assert.equal(spec.argv[spec.argv.indexOf('--extension') + 1], path.resolve(__dirname, '../../scripts/harness-v2-bridge/pi/prime.ts'))
  assert.equal(spec.argv[spec.argv.indexOf('--provider') + 1], 'gateway')
  assert.equal(spec.env.COMPANY_GATEWAY_KEY, 'fixture-key')
  assert.equal(spec.env.NODE_OPTIONS, undefined)
  assert.equal(spec.env.AUTOPROMPT_TOOL_POLICY_SHA256, prepared.policySha256)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spec.env.PRIME_AGENT_CODING_AGENT_DIR, 'models.json'))), { providers: connection().providers })
})
