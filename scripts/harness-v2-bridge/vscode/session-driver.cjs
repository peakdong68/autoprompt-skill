'use strict'

// Supported extension-host runner entry. This starts a fresh owned VS Code
// process for each assignment; its durable conversations belong to Autoprompt,
// not the user's built-in Chat history. The host exits and drains afterward.
exports.run = async function run() {
  try {
  const vscode = require('vscode')
  const extension = vscode.extensions.getExtension('autoprompt.autoprompt-native-bridge')
  if (!extension) throw new Error('Owned Autoprompt extension was not discovered')
  const api = await extension.activate()
  await api.runOwnedSession(event => console.log(`AUTOPROMPT_EVENT ${JSON.stringify(event)}`))
  } catch (error) { console.log(`AUTOPROMPT_EVENT ${JSON.stringify({ type: 'owned.error', code: error.code || 'CHILD_RUNTIME_FAILURE', message: error.message })}`); throw error }
}
