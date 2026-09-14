'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const bridge = require('../../scripts/harness-v2-bridge/vscode/extension.cjs')

test('VS Code public LM capability projection stays fail-closed without billed usage or native chat identity', async () => {
  const vscode = {
    version: '1.133.0',
    lm: {
      async selectChatModels() {
        return [{ id: 'fixture-model', vendor: 'fixture', family: 'fixture-family', version: '1' }]
      },
    },
  }
  const result = await bridge.capabilities(vscode)
  assert.deepEqual(result, {
    protocolVersion: 1,
    provider: 'vscode',
    extensionId: 'autoprompt.autoprompt-native-bridge',
    extensionHostVersion: '1.133.0',
    languageModelApi: true,
    models: [{ id: 'fixture-model', vendor: 'fixture', family: 'fixture-family', version: '1' }],
    exactUsage: false,
    nativeSessionContinuation: false,
    conformance: 'NOT_SUPPORTED',
    blockers: ['PROVIDER_BILLED_USAGE_UNAVAILABLE', 'NATIVE_CHAT_SESSION_API_UNAVAILABLE'],
  })
  assert.equal(native.descriptor('vscode').protocol, 'vscode-owned-json')
  assert.deepEqual(native.descriptor('vscode').blockers, [], 'The separate owned BYOK backend has exact receipts; generic models still do not')
})

test('VS Code bridge never upgrades a missing language-model API into execution support', async () => {
  const result = await bridge.capabilities({ version: '1.133.0' })
  assert.equal(result.languageModelApi, false)
  assert.deepEqual(result.models, [])
  assert.equal(result.exactUsage, false)
  assert.equal(result.nativeSessionContinuation, false)
  assert.equal(result.conformance, 'NOT_SUPPORTED')
})

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { probeExtensionBridge } = require('../../scripts/harness-v2-vscode-bridge.cjs')

function bridgeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-bridge-'))
  fs.chmodSync(root, 0o700)
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(root, 'token'), token, { mode: 0o600 })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, token }
}
function request(root, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(root, 'bridge.sock'))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end(`${JSON.stringify(payload)}\n`))
    socket.on('data', chunk => { buffer += chunk })
    socket.on('end', () => { try { resolve(JSON.parse(buffer)) } catch (error) { reject(error) } })
    socket.on('error', reject)
  })
}

test('VS Code bridge authenticates real IPC requests and refuses execution before consulting models', { skip: process.platform === 'win32' }, async t => {
  const { root, token } = bridgeFixture(t)
  let queries = 0
  const context = { subscriptions: [] }
  // The socket, extension transport and probe client are real. This API object
  // is injected; this test is deliberately not evidence of a VS Code host run.
  const api = { version: 'fixture-host', lm: { async selectChatModels() { queries++; return [] } } }
  const running = await bridge.startBridge(context, api, root)
  t.after(() => running.dispose())
  const result = await probeExtensionBridge({ root })
  assert.equal(result.extensionHostVersion, 'fixture-host')
  assert.equal(result.conformance, 'NOT_SUPPORTED')
  assert.equal(queries, 1)
  assert.equal(fs.statSync(path.join(root, 'bridge.sock')).mode & 0o777, 0o600)
  assert.deepEqual(await request(root, { id: 'wrong', token: '0'.repeat(64), method: 'capabilities' }), { error: { code: 'BRIDGE_REQUEST_INVALID' } })
  const denied = await request(root, { id: 'run', token, method: 'execute', prompt: 'must never run' })
  assert.equal(denied.id, 'run')
  assert.equal(denied.error.code, 'PROVIDER_UNSUPPORTED')
  assert.equal(queries, 1)
  running.dispose(); running.dispose()
  assert.equal(fs.existsSync(path.join(root, 'bridge.sock')), false)
})

test('VS Code probe rejects missing endpoints, unsafe credentials and cancellation', { skip: process.platform === 'win32' }, async t => {
  const { root } = bridgeFixture(t)
  await assert.rejects(probeExtensionBridge({ root: path.join(root, 'missing') }), { code: 'EXTENSION_HOST_BRIDGE_REQUIRED' })
  fs.linkSync(path.join(root, 'token'), path.join(root, 'token-copy'))
  await assert.rejects(probeExtensionBridge({ root }), { code: 'EXTENSION_HOST_BRIDGE_REQUIRED' })
  fs.unlinkSync(path.join(root, 'token-copy'))
  const running = await bridge.startBridge({ subscriptions: [] }, { version: 'fixture-host' }, root)
  t.after(() => running.dispose())
  const controller = new AbortController(); controller.abort()
  await assert.rejects(probeExtensionBridge({ root, signal: controller.signal }), { code: 'CHILD_CANCELLED' })
  await assert.rejects(probeExtensionBridge({ root, timeoutMs: Infinity }), { code: 'EXTENSION_HOST_BRIDGE_REQUIRED' })
})

test('VS Code probe enforces a total deadline even while endpoint drips incomplete output', { skip: process.platform === 'win32' }, async t => {
  const { root } = bridgeFixture(t)
  const server = net.createServer(socket => {
    const timer = setInterval(() => socket.write(' '), 10)
    socket.on('error', () => {})
    socket.on('close', () => clearInterval(timer))
  })
  await new Promise(resolve => server.listen(path.join(root, 'bridge.sock'), resolve))
  fs.chmodSync(path.join(root, 'bridge.sock'), 0o600)
  t.after(() => server.close())
  await assert.rejects(probeExtensionBridge({ root, timeoutMs: 80 }), error => error.code === 'EXTENSION_HOST_BRIDGE_REQUIRED' && /timed out/.test(error.message))
})
