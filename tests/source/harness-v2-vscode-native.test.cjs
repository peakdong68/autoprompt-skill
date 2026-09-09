'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const test = require('node:test')

test('real VS Code extension host discovers and authenticates its capability bridge', {
  skip: !process.env.AUTOPROMPT_VSCODE_TEST_CLI || process.platform === 'win32', timeout: 90000,
}, async t => {
  const executable = process.env.AUTOPROMPT_VSCODE_TEST_CLI
  assert.ok(path.isAbsolute(executable), 'Select an absolute native VS Code executable')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vscode-native-'))
  const bridgeRoot = path.join(root, 'bridge')
  fs.mkdirSync(bridgeRoot, { mode: 0o700 })
  fs.writeFileSync(path.join(bridgeRoot, 'token'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  const repo = path.resolve(__dirname, '../..')
  // Isolated settings/extensions prevent consulting user sessions or accounts.
  // Chromium's rendering sandbox is separate from the unimplemented agent
  // execution boundary; no model or workspace mutation runs in this probe.
  const child = spawn(executable, [
    '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--user-data-dir', path.join(root, 'user-data'), '--extensions-dir', path.join(root, 'extensions'),
    '--extensionDevelopmentPath', path.join(repo, 'scripts/harness-v2-bridge/vscode'),
    '--extensionTestsPath', path.join(repo, 'tests/helpers/vscode-native-extension.cjs'),
  ], { env: { ...process.env, AUTOPROMPT_VSCODE_BRIDGE_ROOT: bridgeRoot }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const capture = bytes => { output += bytes; if (Buffer.byteLength(output) > 4 * 1024 * 1024) child.kill('SIGTERM') }
  child.stdout.on('data', capture); child.stderr.on('data', capture)
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 75000)
  t.after(() => {
    clearTimeout(timer)
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, output)
  const marker = /AUTOPROMPT_VSCODE_NATIVE_EVIDENCE (\{[^\r\n]+\})/.exec(output)
  assert.ok(marker, output)
  const evidence = JSON.parse(marker[1])
  assert.match(evidence.version, /^\d+\.\d+\.\d+/)
  assert.equal(evidence.extensionId, 'autoprompt.autoprompt-native-bridge')
  assert.equal(evidence.exactUsage, false)
  assert.equal(evidence.nativeSessionContinuation, false)
  t.diagnostic(JSON.stringify(evidence))
})
