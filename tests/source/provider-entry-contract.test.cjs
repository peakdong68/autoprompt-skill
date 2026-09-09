#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { parseArgs } = require('../../bin/autoprompt.cjs')
const codexConfigure = require('../../scripts/codex-configure.cjs')
const codexCasting = require('../../agents/codex/workflow/codex-agent-casting.js')

const ROOT = path.resolve(__dirname, '..', '..')
const PROVIDERS = [
  'claude', 'codex', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok', 'reasonix',
]
const TEXT_CONTRACT_PROVIDERS = PROVIDERS.filter(provider => !['codex', 'reasonix'].includes(provider))
const SKILLS = new Map(PROVIDERS.map(provider => [
  provider,
  provider === 'prime'
    ? 'agents/prime/skills/autoprompt/SKILL.md'
    : `agents/${provider}/SKILL.md`,
]))

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

for (const provider of TEXT_CONTRACT_PROVIDERS) {
  test(`${provider}: private v2 entry requires explicit controller activation, never a v1 chooser`, () => {
    const source = read(SKILLS.get(provider))
    assert.match(source, new RegExp(`autoprompt activate ${provider} --target`))
    assert.match(source, /loading a skill never creates or resumes a run/)
    assert.match(source, /DIRECT and LIGHT do not require a coordinator or manager/)
    assert.match(source, /There is no default route/)
    assert.match(source, /Refuse any required capability without current provider conformance evidence/)
    assert.doesNotMatch(source, /In an attended session, ask all undefined knobs|Before spawning, resolve only undefined operator knobs/)
    assert.throws(() => parseArgs(['activate', provider]))
    assert.throws(() => parseArgs(['activate', provider, '--']))
    const argv = ['exact request', '--literal', '']
    assert.deepEqual(parseArgs(['activate', provider, '--', ...argv]).missionArgs, argv)
  })
  test(`${provider}: public launcher is manual and model routing never changes the task route`, () => {
    const packaging = require('../../scripts/harness-v2-package.cjs')
    const source = packaging.launcher(provider)
    assert.match(source, /Loading this launcher never starts or resumes work/)
    assert.match(source, new RegExp(`autoprompt activate ${provider} --target`))
    const configure = require('../../scripts/harness-v2-configure.cjs')
    const inherited = { mode: 'provider-default', selector: 'off', models: [] }
    assert.equal(configure.resolveAssignment(inherited, {}, provider).model, null)
    const selection = { mode: 'explicit', selector: 'fixture/model', models: ['fixture/model'] }
    assert.deepEqual(configure.resolveAssignment(selection, { logicalRole: 'worker' }, provider),
      configure.resolveAssignment(selection, { logicalRole: 'route-analyst' }, provider))
    if (['claude', 'opencode', 'kilo', 'vscode', 'prime', 'omp', 'deepseek', 'hermes', 'grok'].includes(provider)) {
      assert.equal(configure.resolveAssignment({ ...selection, effort: 'high' },
        { logicalRole: 'worker' }, provider).effort, 'high')
    } else {
      assert.throws(() => configure.validateSelection({ ...selection, effort: 'high' }, provider), { code: 'INVALID_EFFORT' })
    }
    assert.throws(() => configure.validateSelection({ ...selection, effort: 'invented-effort' }, provider), { code: 'INVALID_EFFORT' })
    assert.throws(() => configure.validateSelection({ mode: 'automatic', selector: 'auto', models: [] }, provider),
      { code: 'MODEL_REGISTRY_RECEIPT_INVALID' })
  })
}

test('native manual metadata matches the actual public launcher format', () => {
  const packaging = require('../../scripts/harness-v2-package.cjs')
  for (const provider of ['claude', 'prime', 'deepseek']) {
    assert.match(packaging.launcher(provider), /^user-invocable: true$/m)
    assert.match(packaging.launcher(provider), /^disable-model-invocation: true$/m)
  }
  assert.equal(packaging.launcherRelative('omp'), 'prompts/autoprompt.md')
  assert.equal(packaging.launcherRelative('vscode'), 'skills/autoprompt/SKILL.md')
  assert.match(read(SKILLS.get('reasonix')), /^invocation: manual$/m)
})

test('Codex entry behavior requires an explicit activation mission and never resumes from a bare invocation', () => {
  assert.deepEqual(parseArgs([]), { command: 'help' })
  assert.throws(() => parseArgs(['activate', 'codex']))
  assert.throws(() => parseArgs(['activate', 'codex', '--']))
  assert.deepEqual(parseArgs(['activate', 'codex', '--', 'fix', 'the', 'bug']), {
    command: 'activate', provider: 'codex', missionArgs: ['fix', 'the', 'bug'], compatibilityAlias: false,
  })
})

test('Codex chooser and casting behavior enforce real selector, model, and effort capabilities', () => {
  assert.throws(() => codexConfigure.resolveSelector('', ''), /invalid model identifier/i)
  assert.deepEqual(codexConfigure.resolveSelector('off', ''), { selector: 'off', models: [], registry: '' })
  assert.deepEqual(codexConfigure.resolveSelector('gpt-5.6-sol,gpt-5.6-terra', ''), {
    selector: 'gpt-5.6-sol,gpt-5.6-terra', models: ['gpt-5.6-sol', 'gpt-5.6-terra'], registry: '',
  })
  assert.deepEqual(codexConfigure.resolveSelector('z-ai/glm-5.3-flash', ''), {
    selector: 'z-ai/glm-5.3-flash', models: ['z-ai/glm-5.3-flash'], registry: '',
  })
  assert.throws(() => codexConfigure.resolveSelector('auto', ''), /absolute readable --model-map/i)

  assert.deepEqual(codexCasting.validateAgentCast([
    { file: 'ap-worker.toml', model: null, effort: null },
  ], 'off', ''), {
    enabled: false, models: [], effort: { status: 'inherited-only', source: 'session-inheritance' },
  })
  assert.deepEqual(codexCasting.validateAgentCast([
    { file: 'ap-worker.toml', model: 'gpt-5.6-sol', effort: 'xhigh' },
    { file: 'ap-reviewer.toml', model: 'gpt-5.6-terra', effort: 'high' },
  ], 'gpt-5.6-sol,gpt-5.6-terra', ''), {
    enabled: true,
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    effort: { status: 'selectable', source: 'codex-custom-agent-toml' },
  })
  assert.throws(() => codexCasting.validateAgentCast([
    { file: 'ap-worker.toml', model: 'gpt-5.6-sol', effort: null },
  ], 'gpt-5.6-sol', ''), /requires model_reasoning_effort/i)
})

test('retained v1 migration validator does not allow unattended early dispatch', () => {
  const { startupHandshakeFindings } = require('../../agents/claude/workflow/autoprompt-ledger-check.js')
  const transcript = firstToolUseName => ({
    path: '00-conductor-root.jsonl',
    firstToolUseName,
    hasUserInterrupt: false,
  })

  for (const tool of ['Agent', 'Task']) {
    const findings = startupHandshakeFindings({ attended: true, transcripts: [transcript(tool)] })
    assert.equal(findings.length, 1, `${tool} must not bypass the attended chooser`)
    assert.equal(findings[0].rule, 'startupHandshakeFindings')
  }

  assert.deepEqual(startupHandshakeFindings({
    attended: true,
    transcripts: [{ ...transcript('AskUserQuestion'), hasUserInterrupt: true }],
  }), [])
  assert.deepEqual(startupHandshakeFindings({ attended: false, transcripts: [transcript('Agent')] }), [])
})

// Both v2 entries bind exact mission arguments through explicit launchers.
test('Reasonix entry requires an explicit mission and private activation', () => {
  assert.throws(() => parseArgs(['activate', 'reasonix']))
  assert.throws(() => parseArgs(['activate', 'reasonix', '--']))
  assert.deepEqual(parseArgs(['activate', 'reasonix', '--', 'fix', 'the bug']), {
    command: 'activate', provider: 'reasonix', missionArgs: ['fix', 'the bug'], compatibilityAlias: false,
  })
  assert.match(read(SKILLS.get('reasonix')), /autoprompt activate reasonix/)
  assert.match(read(SKILLS.get('reasonix')), /loading a skill alone never creates or resumes a run/)
})
