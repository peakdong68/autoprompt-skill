'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { renderConfig, renderCredentials, probeExecutable } = require('../../agents/reasonix/workflow/native.js')
const { ReasonixEventStream } = require('../../agents/reasonix/workflow/transport.js')
const { modelService, runNative } = require('../helpers/harness-native-service.cjs')

test('Reasonix private-home credentials authenticate the native model but never reach a real Bash subprocess', {
  skip: !process.env.AUTOPROMPT_REASONIX_TEST_CLI, timeout: 60000,
}, async () => {
  const binding = probeExecutable({ executable: process.env.AUTOPROMPT_REASONIX_TEST_CLI })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-native-credentials-'))
  const directories = Object.fromEntries(['home', 'cwd', 'target', 'scratch'].map(name => [name, path.join(root, name)]))
  for (const dir of Object.values(directories)) fs.mkdirSync(dir, { mode: 0o700 })
  const credentialName = 'AUTOPROMPT_FIXTURE_API_KEY'
  const credential = 'synthetic-model-key-must-not-reach-tools'
  const command = `printenv ${credentialName}`
  const service = await modelService('reasonix', { name: 'bash', args: { command } }, { expectedBearer: credential })
  try {
    const connection = { default_model: 'fixture', providers: [{ name: 'fixture', kind: 'openai', model: 'fixture',
      base_url: `${service.url}/v1`, api_key_env: credentialName }] }
    // v1.30 reads provider credentials from its private home, not the inherited
    // environment. Exercise the production serializer without supplying the key
    // to runNative: authenticated requests must therefore come from this file.
    const credentialPath = path.join(directories.home, '.env')
    fs.writeFileSync(credentialPath, renderCredentials(connection, { [credentialName]: credential }), { flag: 'wx', mode: 0o600 })
    if (process.platform !== 'win32') assert.equal(fs.statSync(credentialPath).mode & 0o777, 0o600)
    fs.writeFileSync(path.join(directories.home, 'config.toml'), renderConfig({
      connection,
      systemPrompt: 'Perform the assigned credential isolation check. Return exactly {"ok":true}.',
      targetPath: directories.target, scratchPath: directories.scratch, readOnly: true,
    }), { mode: 0o600 })
    const completed = await runNative(binding.path, {
      argv: ['run', '--permission-mode', 'auto', '--output-format', 'stream-json', '--dir', directories.cwd, '--max-steps', '3'],
      cwd: directories.cwd, stdin: 'Check that the API credential is unavailable in a tool subprocess.',
      env: { PATH: process.env.PATH, HOME: directories.home, REASONIX_HOME: directories.home,
        REASONIX_STATE_HOME: path.join(root, 'state'), REASONIX_CACHE_HOME: path.join(root, 'cache') },
    }, { evidenceRoot: process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT, evidenceName: 'reasonix-credential-isolation' })
    assert.equal(completed.timedOut, false, completed.stderr)
    assert.equal(completed.truncated, false, 'Credential checks require complete native output')
    assert.equal(completed.status, 0, completed.stderr + completed.stdout)
    assert.equal(completed.signal, null)
    const events = []
    const stream = new ReasonixEventStream({ onEvent: event => events.push(event) })
    for (const line of completed.stdout.trim().split(/\r?\n/)) if (line.trim()) stream.push(line)
    assert.deepEqual(stream.finish().output, { ok: true })
    const results = events.filter(event => event.kind === 'tool_result')
    assert.equal(results.length, 1, 'Exactly one real tool result is required; final assistant text alone proves nothing')
    const result = results[0].tool
    assert.equal(result.name, 'bash')
    assert.deepEqual(JSON.parse(result.args), { command })
    assert.equal(result.execution?.exitCode, 1, JSON.stringify(result))
    assert.equal(result.execution?.failurePhase, 'execution', 'A rejected tool invocation does not prove subprocess filtering')
    assert.equal(result.err, 'command exited: exit status 1')
    assert.equal(result.output, 'error: command exited: exit status 1\n', 'The native exit diagnostic must contain no credential bytes')
    assert.equal(completed.stdout.includes(credential), false)
    assert.equal(completed.stderr.includes(credential), false)
    assert.equal(JSON.stringify(service.requests).includes(credential), false, 'Tool results and model request bodies must not contain credential bytes')
    assert.equal(service.completed, 2)
    const modelRequests = service.requests.filter(request => request.path.includes('/chat/completions'))
    assert.equal(modelRequests.length, 2, 'Both the tool request and the post-tool request must reach the real model client')
    assert.ok(modelRequests.every(request => request.fixtureCredentialAccepted === true),
      'The real model client must authenticate from private .env while the Bash subprocess has no credential')
    assert.deepEqual(service.errors, [])
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
