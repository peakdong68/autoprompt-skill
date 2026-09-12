#!/usr/bin/env node
'use strict'

// This child is deliberately its own process group.  The lifecycle service can
// kill that group when the bridge disappears, including when the bridge itself
// was SIGKILLed and therefore could not send a cancellation frame.
const { run, providerConfiguration, GUEST_ROOT } = require('./lima-runtime-guest.cjs')

function report(value) {
  if (typeof process.send === 'function') process.send(value)
}
let completed = false
function finish(value, exitCode) {
  completed = true
  if (typeof process.send !== 'function') process.exit(exitCode)
  // A forked child keeps its IPC descriptor referenced after the command has
  // completed.  Report first, then exit explicitly; merely assigning
  // process.exitCode leaves a successful request permanently RUNNING.
  process.send(value, () => process.exit(exitCode))
}
// The lifecycle service owns this IPC channel.  If that owner disappears, do
// not keep a guest CLI alive as an orphan.  The production worker is launched
// detached, so its process group contains only owned descendants.
process.once('disconnect', () => {
  if (completed) return
  try { process.kill(-process.pid, 'SIGTERM') } catch (error) {
    if (error.code === 'ESRCH') process.kill(process.pid, 'SIGTERM')
    else throw error
  }
})
process.once('message', async request => {
  let display, response, exitCode
  try {
    const configuration = providerConfiguration()
    if (request?.action === 'exec' && request.argv?.[0] === 'activate' && request.argv?.[1] === 'vscode') {
      if (configuration.provider !== 'vscode') throw Object.assign(new Error('Activation provider does not match the configured guest provider'), { code: 'LIMA_PROVIDER_CONFIG_INVALID' })
      const { startOwnedDisplay } = require('./lima-runtime-vscode-display.cjs')
      display = await startOwnedDisplay({ root: GUEST_ROOT, requestId: request.requestId })
      for (const [name, value] of Object.entries(display.environment)) process.env[name] = value
    }
    const result = await run(request)
    response = { type: 'result', result }
    exitCode = typeof result === 'number' ? result : 0
  } catch (error) {
    response = { type: 'error', code: error.code || 'LIMA_GUEST_FAILED', message: error.message }
    exitCode = 2
  }
  try { await display?.stop() }
  catch (error) {
    response = { type: 'error', code: error.code || 'LIMA_VSCODE_DISPLAY_UNDRAINED', message: error.message }
    exitCode = 2
  }
  finish(response, exitCode)
})
