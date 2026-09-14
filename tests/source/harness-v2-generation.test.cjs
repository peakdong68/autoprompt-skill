'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const test = require('node:test')
const toml = require('@iarna/toml')
const g = require('../../scripts/generate-provider-contracts.cjs')
const ROOT = path.resolve(__dirname, '../..')
const contracts = g.loadCodexV2Contracts(ROOT)
const canonical = g.renderCodexOutputs(ROOT)
const roles = contracts.rolePolicy.physical_roles
const rendered = new Map(g.HARNESS_V2_PROVIDERS.map(provider => [provider, g.renderHarnessV2Outputs(provider, ROOT)]))
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
const json = (outputs, file) => JSON.parse(outputs.get(file))
const entryPath = provider => `agents/${provider}/${provider === 'prime' ? 'skills/autoprompt/' : ''}SKILL.md`
const field = (source, name) => {
  const value = source.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]
  assert.notEqual(value, undefined, `missing ${name}`)
  return JSON.parse(value)
}

for (const provider of g.HARNESS_V2_PROVIDERS) {
  const prefix = `agents/${provider}/`
  const outputs = rendered.get(provider)
  const projection = json(outputs, `${prefix}native-projection.json`)

  test(`${provider}: all 32 policy roles preserve schemas, modes, authority, aliases and owned resources`, () => {
    const policy = json(outputs, `${prefix}role-policy.json`)
    assert.deepEqual(policy, { ...contracts.rolePolicy, policy_id: contracts.rolePolicy.policy_id.replace('codex', provider) })
    assert.deepEqual(Object.keys(projection.roles).sort(), Object.keys(roles).sort())
    assert.equal(Object.keys(projection.roles).length, 32)
    const schema = structuredClone(contracts.rolePolicySchema)
    schema.$id = schema.$id.replace('codex', provider)
    schema.properties.policy_id.const = policy.policy_id
    assert.deepEqual(json(outputs, `${prefix}role-policy.schema.json`), schema)
    for (const [id, role] of Object.entries(roles)) {
      const projected = projection.roles[id]
      const source = outputs.get(prefix + projected.path)
      assert.ok(source, id)
      assert.deepEqual(projected.allowedChildren, role.allowed_children, id)
      assert.deepEqual(projected.allowedParents, role.allowed_parents, id)
      assert.deepEqual(projected.supportedModes, role.supported_modes, id)
      assert.deepEqual(projected.resourceSets, role.resource_sets, id)
      assert.deepEqual(projected.decisionRights, role.decision_rights, id)
      assert.equal(projected.logicalVersion, role.logical_version, id)
      assert.equal(projected.layer, role.layer, id)
      assert.equal(projected.phase, role.phase, id)
      assert.equal(projected.mode, role.mode, id)
      assert.equal(projected.mutualExclusionGroup, role.mutual_exclusion_group, id)
      assert.equal(projected.telemetryRequired, role.telemetry_required, id)
      assert.deepEqual(projected.compatibilityAlias, role.compatibility_alias, id)
      assert.equal(projected.inputSchemaId, role.input_schema_id)
      assert.equal(projected.outputSchemaId, role.output_schema_id)
      assert.equal(projected.activationAllowed, role.activation_allowed)
      assert.equal(projected.canDispatch, role.can_dispatch)
      const codex = toml.parse(canonical.get(`agents/codex/agents/${id}.toml`))
      const body = codex.developer_instructions.split('\n').slice(1).join('\n').trim()
        .replace('You may start only these registered child roles:', 'You may request only these registered child roles through the controller:')
      assert.ok(source.includes(body), `${id} must retain every canonical instruction`)
      if (role.compatibility_alias.enabled) {
        assert.equal(projected.activationAllowed, false)
        assert.deepEqual(projected.allowedChildren, [])
        assert.deepEqual(projected.resourceSets.write, [])
        assert.match(source, /cannot be activated as a new version 2 role/)
      }
    }
  })

  test(`${provider}: native tools close delegation and read-only mutation while retaining controller child edges`, () => {
    assert.equal(projection.dispatchOwner, 'external-controller')
    assert.equal(projection.nativeDispatchAllowed, false)
    assert.equal(projection.internalRoleVisibility, 'private')
    for (const [id, role] of Object.entries(roles)) {
      const projected = projection.roles[id]
      const source = outputs.get(prefix + projected.path)
      assert.deepEqual(projected.nativeChildRoles, [])
      assert.equal(projected.tools.some(tool => /^(Agent|Task|Skill|agent|task|skill|rlm|subagent)/.test(tool)), false, id)
      if (role.sandbox_mode === 'read-only') {
        assert.equal(projected.tools.some(tool => /^(write|edit|bash|pwsh|execute)$/i.test(tool)), false, id)
      }
      assert.match(source, /controller owns every physical child launch/)
      if (provider === 'claude') {
        assert.deepEqual(field(source, 'tools'), projected.tools)
        assert.ok(field(source, 'disallowedTools').includes('Agent'))
        assert.match(source, /^model: inherit$/m)
      } else if (['opencode', 'kilo'].includes(provider)) {
        assert.match(source, /^mode: subagent\nhidden: true\npermission:\n  "\*": deny/m)
        assert.match(source, /^  task: deny\n  skill: deny$/m)
        if (role.sandbox_mode === 'read-only') assert.match(source, /^  edit: deny\n  bash: deny$/m)
      } else if (provider === 'vscode') {
        assert.deepEqual(field(source, 'tools'), projected.tools)
        assert.deepEqual(field(source, 'agents'), [])
        assert.equal(field(source, 'user-invocable'), false)
        assert.equal(field(source, 'disable-model-invocation'), true)
      } else if (provider === 'omp') {
        assert.deepEqual(field(source, 'tools'), projected.tools)
        assert.deepEqual(field(source, 'spawns'), [])
        assert.equal(field(source, 'prewalk'), false)
        assert.equal(field(source, 'advisor'), false)
      }
      if (!role.can_dispatch) assert.match(source, /(?:Do not start another agent|You cannot start another agent)/)
      else for (const child of role.allowed_children) assert.ok(source.includes(`\`${child}\``))
    }
  })

  test(`${provider}: full gates, route examples and all 18 framework graphs round-trip to the canonical base`, () => {
    assert.equal(g.validateHarnessV2Outputs(provider, outputs, contracts, ROOT), true)
    assert.deepEqual(g.parseFullCompiledGates(outputs.get(`${prefix}GATES.md`)),
      g.parseFullCompiledGates(canonical.get('agents/codex/GATES.md')))
    assert.deepEqual(g.parseCompiledRouteExamples(outputs.get(entryPath(provider))),
      g.parseCompiledRouteExamples(canonical.get('agents/codex/SKILL.md')))
    const analyst = outputs.get(prefix + projection.roles['ap-route-analyst'].path)
    assert.deepEqual(g.parseCompiledRouteExamples(analyst), g.parseCompiledRouteExamples(canonical.get('agents/codex/agents/ap-route-analyst.toml')))
    const frameworkRoot = `${prefix}${provider === 'prime' ? 'prompts/' : ''}frameworks/`
    assert.equal([...outputs.keys()].filter(file => file.startsWith(frameworkRoot)).length, 18)
    for (const file of Object.keys(g.codexFrameworkRoutes(ROOT))) {
      assert.deepEqual(g.parseFrameworkCompiledGates(outputs.get(frameworkRoot + file)),
        g.parseFrameworkCompiledGates(canonical.get('agents/codex/frameworks/' + file)), file)
    }
    assert.match(outputs.get(`${prefix}MODES.md`), /## DIRECT[\s\S]*Coordinator allowed: `false`[\s\S]*## LIGHT[\s\S]*Coordinator allowed: `false`/)
    assert.match(outputs.get(entryPath(provider)), new RegExp(`autoprompt activate ${provider} --target <absolute-project> -- <request>`))
    assert.match(outputs.get(entryPath(provider)), /loading a skill never creates or resumes a run/)
    assert.match(outputs.get(`${prefix}README.md`), /Generation parity is not runtime conformance/)
    assert.equal(projection.runtimeAdmission, 'independent-capability-evidence-required')
    assert.equal(g.validateGeneratedPlainLanguage(outputs, contracts.plainLanguage), true)
  })

  test(`${provider}: translated entry, analyst and framework corruption fails generation validation`, () => {
    for (const file of [entryPath(provider), prefix + projection.roles['ap-route-analyst'].path]) {
      const corrupted = new Map(outputs)
      corrupted.set(file, outputs.get(file).replace(/sha256=[a-f0-9]{64}/, `sha256=${'0'.repeat(64)}`))
      assert.throws(() => g.validateHarnessV2Outputs(provider, corrupted, contracts, ROOT), /route example hash is stale/)
    }
    const framework = `${prefix}${provider === 'prime' ? 'prompts/' : ''}frameworks/apply.md`
    const corrupted = new Map(outputs)
    corrupted.set(framework, outputs.get(framework).replace(/sha256=[a-f0-9]{64}/, `sha256=${'0'.repeat(64)}`))
    assert.throws(() => g.validateHarnessV2Outputs(provider, corrupted, contracts, ROOT), /check registry hash is stale/)
    corrupted.delete(framework)
    assert.throws(() => g.validateHarnessV2Outputs(provider, corrupted, contracts, ROOT), /framework check projection/)
  })
}

test('native frontmatter and both DeepSeek preset encodings parse as YAML with exact tool restrictions', t => {
  // Parse the real serialization independently of the generator's line helpers.
  // Python/PyYAML is also used by the skill validator; no runtime dependency is added.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v2-native-yaml-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const payload = []
  for (const [provider, outputs] of rendered) {
    const projection = json(outputs, `agents/${provider}/native-projection.json`)
    for (const [id, projected] of Object.entries(projection.roles)) {
      if (['prime', 'hermes', 'grok'].includes(provider)) continue
      payload.push({ provider, id, projected, source: outputs.get(`agents/${provider}/${projected.path}`) })
    }
  }
  const script = [
    'import json, sys, yaml',
    'with open(sys.argv[1]) as source: items = json.load(source)',
    'for item in items:',
    '    header = yaml.safe_load(item["source"].split("---", 2)[1])',
    '    provider, projected = item["provider"], item["projected"]',
    '    assert isinstance(header["description"], str)',
    '    if provider in ("opencode", "kilo"):',
    '        permissions = header["permission"]',
    '        assert permissions["*"] == permissions["task"] == permissions["skill"] == "deny"',
    '        assert header["mode"] == "subagent" and header["hidden"] is True',
    '        for tool in projected["tools"]:',
    '            assert permissions.get("edit" if tool == "write" else tool, permissions["*"]) == "allow"',
    '    elif provider != "deepseek":',
    '        assert header["tools"] == projected["tools"]',
    '    if provider == "omp":',
    '        assert header["spawns"] == [] and "task" not in header["tools"]',
    '        assert header["prewalk"] is False and header["advisor"] is False',
    'print(len(items))',
  ].join('\n')
  const payloadFile = path.join(temporary, 'profiles.json')
  fs.writeFileSync(payloadFile, JSON.stringify(payload))
  const result = childProcess.spawnSync('python3', ['-c', script, payloadFile], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(Number(result.stdout.trim()), 192)

  const deepseek = rendered.get('deepseek')
  for (const file of ['agent-preset/agent.cordis.yml', 'headless.patch.yml']) {
    const yamlFile = path.join(temporary, 'preset.yml')
    const jsonFile = path.join(temporary, 'preset.json')
    fs.writeFileSync(yamlFile, deepseek.get(`agents/deepseek/${file}`))
    const parsed = childProcess.spawnSync('python3', ['-c',
      'import json, pathlib, sys, yaml; pathlib.Path(sys.argv[2]).write_text(json.dumps(yaml.safe_load(pathlib.Path(sys.argv[1]).read_text())))',
      yamlFile, jsonFile], {
      encoding: 'utf8', timeout: 30000,
    })
    assert.equal(parsed.status, 0, parsed.stderr)
    const entries = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    const profiles = (file.startsWith('headless') ? entries[0].insert : entries)
      .filter(entry => entry.name === '@deepseek-ai/dsh-tool-subagent')
    assert.equal(profiles.length, 32)
    for (const { config } of profiles) {
      const id = config.toolName.replaceAll('_', '-')
      assert.deepEqual(config.toolFilter.allow,
        json(deepseek, 'agents/deepseek/native-projection.json').roles[id].tools)
      assert.equal(config.maxDepth, 1)
      assert.ok(config.persona.includes(roles[id].input_schema_id))
    }
  }
})

test('all generated native files are current, private and free of the v1 startup protocol', () => {
  for (const [provider, outputs] of rendered) {
    assert.deepEqual(g.differingOutputs(outputs, ROOT), [], provider)
    for (const [file, content] of outputs) {
      assert.ok(file.startsWith(`agents/${provider}/`), file)
      assert.doesNotMatch(file, /\/workflow\//)
      assert.doesNotMatch(content, /Before spawning, resolve only undefined operator knobs|After the chooser|SEALED AUTOPROMPT DISPATCH ENVELOPE|RLM_DEPTH|rlmMaxDepth/)
      if (!file.endsWith('.md')) continue
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0]
        if (!target || /^[a-z]+:/i.test(target)) continue
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), target))
        assert.ok(outputs.has(relative) || fs.existsSync(path.join(ROOT, relative)), `${file}: broken link ${target}`)
      }
    }
  }
})

test('DeepSeek fixed-persona allowlists match every private role and exclude unknown extension tools', () => {
  const outputs = rendered.get('deepseek')
  for (const file of ['agents/deepseek/agent-preset/agent.cordis.yml', 'agents/deepseek/headless.patch.yml']) {
    const source = outputs.get(file)
    const blocks = [...source.matchAll(/toolName: (ap_[a-z0-9_]+)\n([\s\S]*?)(?=\n\s*- id:|$)/g)]
    assert.equal(blocks.length, 32)
    for (const [, tool, body] of blocks) {
      const id = tool.replaceAll('_', '-')
      assert.deepEqual(JSON.parse(body.match(/allow: (.+)/)[1]),
        json(outputs, 'agents/deepseek/native-projection.json').roles[id].tools)
      assert.match(body, /maxDepth: 1/)
      assert.match(body, /persona: \|-/)
      assert.doesNotMatch(body, /allow: .*\b(?:subagent|bash|pwsh|ap_)\b/)
    }
  }
})

test('Prime retires the automatic injector and rejects both old Python dispatch entrypoints', () => {
  const outputs = rendered.get('prime')
  const extension = outputs.get('agents/prime/extensions/autoprompt.ts')
  assert.doesNotMatch(extension, /\.on\(|registerCommand|before_agent_start|systemPrompt:/)
  const file = path.join(ROOT, 'agents/prime/skills/autoprompt/src/autoprompt/__init__.py')
  const script = [
    'import asyncio, importlib.util, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("autoprompt", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'for call in [lambda: m.bind("untrusted"), lambda: asyncio.run(m.dispatch("ap-worker", "untrusted"))]:',
    '    try: call()',
    '    except RuntimeError as e: assert "PROVIDER_UNSUPPORTED" in str(e) and m.ACTIVATION in str(e)',
    '    else: raise AssertionError("retired v1 entry was admitted")',
    'print("2 retired entries rejected")',
  ].join('\n')
  const result = childProcess.spawnSync('python3', ['-c', script, file], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /2 retired entries rejected/)
})

test('all registered generation ports open without changing capability evidence or admitting runtimes', () => {
  const before = read('agents/contracts/providers.json')
  const decisions = g.providerProjectionPlan(contracts)
  assert.equal(decisions.length, contracts.providers.providers.length)
  assert.ok(decisions.every(item => item.portOpen && !item.runtimeAdmitted && !item.claimsRealBehavior))
  assert.ok(g.providerProjectionPlan(contracts, ['codex']).filter(item => item.provider !== 'codex').every(item => !item.portOpen))
  assert.equal(read('agents/contracts/providers.json'), before)
  assert.throws(() => g.renderHarnessV2Outputs('codex'), /Unsupported v2 harness/)
  assert.throws(() => g.renderHarnessV2Outputs('../claude'), /Unsupported v2 harness/)
})

test('combined rendering preserves complete Codex and Reasonix outputs and never calls legacy generation', () => {
  const combined = g.renderOutputs(ROOT)
  for (const [file, content] of canonical) assert.equal(combined.get(file), content, file)
  for (const [file, content] of g.renderReasonixOutputs(ROOT)) assert.equal(combined.get(file), content, file)
  for (const outputs of rendered.values()) for (const [file, content] of outputs) assert.equal(combined.get(file), content, file)
  const source = read('scripts/generate-provider-contracts.cjs')
  const renderBody = source.slice(source.indexOf('function renderOutputs('), source.indexOf('function differingOutputs('))
  assert.doesNotMatch(renderBody, /renderLegacyOutputs/)
})

test('selective generation checks native drift and leaves unrelated and Codex source untouched', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-v2-generation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const directory of ['agents/contracts', 'agents/codex', 'assets', 'scripts/install', 'scripts/release/codex']) {
    fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'agents/contracts/autoprompt.contract.json'), '{ invalid legacy source')
  fs.mkdirSync(path.join(root, 'agents/omp'), { recursive: true })
  fs.writeFileSync(path.join(root, 'agents/omp/personal.txt'), 'keep my bytes')
  const codexBefore = fs.readFileSync(path.join(root, 'agents/codex/SKILL.md'), 'utf8')
  let stdout = '', stderr = ''
  const io = { stdout: { write: value => { stdout += value } }, stderr: { write: value => { stderr += value } } }
  assert.equal(g.run(['--omp-only'], root, io), 0)
  assert.match(stdout, /generated 59 provider contract files/)
  assert.equal(g.run(['--omp-only', '--check'], root, io), 0)
  fs.appendFileSync(path.join(root, 'agents/omp/agents/ap-worker.md'), '\nDRIFT\n')
  assert.equal(g.run(['--omp-only', '--check'], root, io), 1)
  assert.match(stderr, /stale outputs: agents\/omp\/agents\/ap-worker.md/)
  assert.equal(fs.readFileSync(path.join(root, 'agents/omp/personal.txt'), 'utf8'), 'keep my bytes')
  assert.equal(fs.readFileSync(path.join(root, 'agents/codex/SKILL.md'), 'utf8'), codexBefore)
  assert.equal(fs.existsSync(path.join(root, 'agents/claude')), false)
  assert.equal(g.run(['--codex-only', '--claude-only'], root, io), 2)
  assert.equal(g.run(['--unknown-only'], root, io), 2)
  const routeFile = path.join(root, 'agents/contracts/routes.json')
  const routes = JSON.parse(fs.readFileSync(routeFile, 'utf8'))
  routes.contractVersion = '1.0.0'
  fs.writeFileSync(routeFile, JSON.stringify(routes))
  assert.throws(() => g.renderHarnessV2Outputs('omp', root), /stale contract version/)
})
