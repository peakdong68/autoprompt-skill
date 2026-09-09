'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { context, write, pkg, ROOT } = require('../helpers/provider-lifecycle-contract.cjs')
const policy = require('../../agents/codex/agents/role-policy.json')
const projection = require('../../agents/prime/native-projection.json')
const { renderOutputs } = require('../../scripts/generate-provider-contracts.cjs')
const { renderManifests } = require('../../scripts/runtime-payload.cjs')
const read = file => fs.readFileSync(path.join(ROOT, 'agents/prime', file), 'utf8')

test('Prime generates the full canonical 32-role private projection and all frameworks', () => {
  const outputs = [...renderOutputs(ROOT).keys()].filter(file => file.startsWith('agents/prime/'))
  const roles = Object.keys(policy.physical_roles).sort()
  assert.equal(roles.length, 32)
  assert.deepEqual(Object.keys(projection.roles).sort(), roles)
  assert.equal(outputs.filter(file => /^agents\/prime\/personas\/ap-.*\.md$/.test(file)).length, roles.length)
  assert.equal(outputs.filter(file => file.startsWith('agents/prime/prompts/frameworks/')).length, 18)
  assert.equal(projection.contractVersion, '2.0.0')
  assert.equal(projection.dispatchOwner, 'external-controller')
  assert.equal(projection.nativeDispatchAllowed, false)
  for (const [role, entry] of Object.entries(projection.roles)) {
    assert.equal(entry.path, `personas/${role}.md`)
    // Logical coordinator dispatch is controller-owned; native dispatch stays closed.
    assert.equal(entry.canDispatch, policy.physical_roles[role].can_dispatch, role)
    assert.deepEqual(entry.nativeChildRoles, [], role)
    assert.match(read(entry.path), /private internal profile/)
    assert.match(read(entry.path), /Do not launch agents with native delegation tools/)
  }
})

test('Prime compatibility extension registers no activation, automatic hooks or recursive dispatch', {
  skip: Number(process.versions.node.split('.')[0]) < 22 ? 'Node 22 is required to load the TypeScript compatibility extension' : false,
}, async () => {
  const extension = await import(pathToFileURL(path.join(ROOT, 'agents/prime/extensions/autoprompt.ts')).href)
  const registrations = []
  const api = new Proxy({}, { get: (_, method) => (...args) => registrations.push({ method, args }) })
  assert.equal(extension.default(api), undefined)
  assert.deepEqual(registrations, [])
})

test('retired Prime Python binding and direct RLM dispatch refuse every caller', () => {
  const script = [
    'import asyncio, importlib.util, sys',
    'sys.dont_write_bytecode = True',
    'spec = importlib.util.spec_from_file_location("retired", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'for role in sys.argv[2:]:',
    ' for method in ["bind", "dispatch"]:',
    '  try:',
    '   result = getattr(module, method)(role, "forged mission")',
    '   if method == "dispatch": asyncio.run(result)',
    '  except RuntimeError as error:',
    '   assert "PROVIDER_UNSUPPORTED" in str(error) and "autoprompt activate prime" in str(error)',
    '  else: raise AssertionError("retired dispatch admitted " + role)',
    'print("retired entrypoints denied")',
  ].join('\n')
  const result = cp.spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script,
    path.join(ROOT, 'agents/prime/skills/autoprompt/src/autoprompt/__init__.py'), ...Object.keys(policy.physical_roles), 'unknown'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`)
  assert.match(result.stdout, /retired entrypoints denied/)
})

test('Prime v2 installation does not register the historic executable package or rewrite depth', t => {
  const { root } = context(t)
  const settings = '{\n // personal packages\n "packages":["existing"], "rlmMaxDepth":1,\n}\r\n'
  write(path.join(root, 'settings.json'), settings)
  const installed = pkg.install('prime', root)
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), settings)
  assert.equal(fs.existsSync(path.join(root, 'packages/autoprompt')), false)
  const publicFiles = pkg.walk(root).filter(file => !file.startsWith('.autoprompt-private/') && !file.startsWith('.autoprompt-'))
  assert.deepEqual(publicFiles.sort(), ['settings.json', 'skills/autoprompt/SKILL.md'])
  assert.equal(fs.existsSync(path.join(installed.bundle, 'agents/prime/personas/ap-worker.md')), true)
  pkg.uninstall('prime', root)
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), settings)
})

test('Prime runtime inventory contains every provider byte with no unmanifested resources', () => {
  const manifest = renderManifests(ROOT).get('agents/manifests/prime-runtime.json')
  assert.deepEqual(pkg.walk(path.join(ROOT, 'agents/prime')).sort(), manifest.files)
  assert.deepEqual(Object.keys(manifest.sha256), manifest.files)
  assert.equal(manifest.files.filter(file => /^personas\/ap-.*\.md$/.test(file)).length, 32)
  for (const file of ['role-policy.json', 'native-projection.json', 'skills/autoprompt/SKILL.md']) assert.ok(manifest.files.includes(file))
})
