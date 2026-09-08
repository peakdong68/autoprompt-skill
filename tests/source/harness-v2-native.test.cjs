'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')
const { HarnessEventStream } = require('../../scripts/harness-v2-transport.cjs')
const { modelService, runNative } = require('../helpers/harness-native-service.cjs')

for (const provider of ['claude', 'opencode', 'kilo']) {
  test(`${provider} native reads an actual file, accounts tokens and continues the same native session`, {
    skip: !process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`], timeout: 120000,
  }, async () => {
    const binding = native.probeExecutable({ provider, executable: process.env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`] })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${provider}-native-v2-`))
    const target = path.join(root, 'target'), cwd = path.join(root, 'empty-cwd'), sessionRoot = path.join(root, 'session')
    for (const dir of [target, cwd, sessionRoot]) fs.mkdirSync(dir, { mode: 0o700 })
    const file = path.join(target, 'evidence.txt'), marker = `actual-${provider}-native-tool-evidence`
    fs.writeFileSync(file, `${marker}\n`)
    fs.writeFileSync(path.join(target, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')
    const service = await modelService(provider, provider === 'claude'
      ? { name: 'Read', args: { file_path: file } } : { name: 'read', args: { filePath: file } })
    try {
      const connection = provider === 'claude'
        ? { model: 'claude-sonnet-4-6', environment: { ANTHROPIC_BASE_URL: service.url } }
        : { model: 'fixture/model', providers: { fixture: { npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `${service.url}/v1`, apiKey: 'fixture-not-a-secret' },
          models: { model: { name: 'Fixture Model', limit: { context: 32768, output: 2048 },
            variants: { medium: { reasoningEffort: 'medium' } } } } } } }
      async function run(number, continuationId) {
        const home = path.join(root, `launch-${number}`)
        const launch = native.createLaunch({ provider, home, sessionRoot, targetPath: target, cwd,
          prompt: 'Use only the advertised read tool when requested, and return one JSON object. Never spawn agents.',
          input: number === 1 ? 'FIRST_CONTEXT_SENTINEL: read the assigned file and return {"ok":true}.' : 'Continue the existing context and return {"ok":true}.',
          connection, credentials: { ANTHROPIC_API_KEY: 'fixture-not-a-secret' }, environment: { PATH: process.env.PATH },
          readOnly: true, continuationId, effort: provider === 'claude' ? 'high' : 'medium' })
        const completed = await runNative(binding.path, launch, {
          evidenceRoot: process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT,
          evidenceName: `${provider}-${number}`,
        })
        assert.equal(completed.timedOut, false, completed.stderr + completed.stdout)
        assert.equal(completed.truncated, false)
        assert.equal(completed.status, 0, completed.stderr + completed.stdout)
        assert.equal(completed.signal, null)
        const events = []
        const stream = new HarnessEventStream(provider, { continuationId, readOnly: true, onEvent: event => events.push(event) })
        for (const line of completed.stdout.trim().split(/\r?\n/)) if (line.trim()) stream.push(line)
        return { parsed: stream.finish(), events, stdout: completed.stdout }
      }
      const first = await run(1)
      assert.deepEqual(first.parsed.output, { ok: true })
      assert.equal(first.parsed.usage.noncachedInput, 200)
      assert.equal(first.parsed.usage.cachedInput, 0)
      assert.equal(first.parsed.usage.output, 20)
      assert.ok(first.stdout.includes(marker), 'The actual native tool must read the target, not merely request a denied read')
      if (provider === 'claude') {
        const modelRequests = service.requests.filter(request => request.path.includes('/messages'))
        assert.ok(modelRequests.length > 0)
        assert.ok(modelRequests.every(request => request.body.output_config?.effort === 'high'),
          `Claude effort did not reach the native HTTP requests: ${JSON.stringify(modelRequests.map(request => request.body.output_config))}`)
      }
      if (provider === 'opencode' || provider === 'kilo') {
        const modelRequests = service.requests.filter(request => request.path.includes('/chat/completions'))
        assert.ok(modelRequests.length > 0)
        assert.ok(modelRequests.every(request => request.body.reasoning_effort === 'medium'),
          `${provider} effort did not reach OpenAI-compatible HTTP requests: ${JSON.stringify(modelRequests.map(request => request.body.reasoning_effort))}`)
      }
      assert.ok(service.requests.every(request => !JSON.stringify(request.body).includes('PROJECT_INSTRUCTION_MUST_NOT_AUTOLOAD')))
      const before = service.requests.length
      const resumed = await run(2, first.parsed.sessionId)
      assert.equal(resumed.parsed.sessionId, first.parsed.sessionId)
      assert.deepEqual(resumed.parsed.output, { ok: true })
      assert.equal(resumed.parsed.usage.noncachedInput, 100)
      assert.equal(resumed.parsed.usage.output, 10)
      assert.ok(service.requests.slice(before).some(request => Array.isArray(request.body.messages) && JSON.stringify(request.body.messages).includes('FIRST_CONTEXT_SENTINEL')), 'Native continuation must carry prior context, not only reuse an identifier')
      assert.deepEqual(service.errors, [])
      assert.equal(service.completed, 3, 'Unobserved title, compaction, or other auxiliary requests must not escape the usage ledger')
      assert.equal(fs.readFileSync(file, 'utf8'), `${marker}\n`)
      assert.deepEqual(fs.readdirSync(target).sort(), ['AGENTS.md', 'evidence.txt'])
    } finally {
      if (process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT) {
        fs.mkdirSync(process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(process.env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT, `${provider}-requests.json`),
          JSON.stringify({ requests: service.requests, errors: service.errors }, null, 2), { mode: 0o600 })
      }
      await service.close(); fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
