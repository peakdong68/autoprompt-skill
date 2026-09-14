'use strict'

// Loaded by the actual VS Code extension test host, never by a mocked module.
const assert = require('node:assert/strict')
const vscode = require('vscode')
const { probeExtensionBridge } = require('../../scripts/harness-v2-vscode-bridge.cjs')

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('autoprompt.autoprompt-native-bridge')
  assert.ok(extension, 'The actual host must discover the development extension')
  await extension.activate()
  const command = await vscode.commands.executeCommand('autoprompt.native.capabilities')
  const ipc = await probeExtensionBridge({ root: process.env.AUTOPROMPT_VSCODE_BRIDGE_ROOT })
  assert.equal(ipc.extensionHostVersion, vscode.version)
  assert.equal(ipc.extensionId, extension.id)
  assert.equal(ipc.languageModelApi, typeof vscode.lm?.selectChatModels === 'function')
  assert.deepEqual(ipc.blockers, command.blockers)
  assert.equal(ipc.conformance, 'NOT_SUPPORTED')
  assert.equal(ipc.exactUsage, false)
  assert.equal(ipc.nativeSessionContinuation, false)
  console.log(`AUTOPROMPT_VSCODE_NATIVE_EVIDENCE ${JSON.stringify({ version: vscode.version, extensionId: extension.id, languageModelApi: ipc.languageModelApi, exactUsage: ipc.exactUsage, nativeSessionContinuation: ipc.nativeSessionContinuation, models: ipc.models, blockers: ipc.blockers })}`)
}
