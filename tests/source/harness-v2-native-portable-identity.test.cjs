'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const native = require('../../scripts/harness-v2-native.cjs')

function fixture(parent, marker = 'original') {
  const root = path.join(parent, 'grok-build')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(root, 'node_modules', 'fixture-dependency'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@fixture/grok-build', version: '1.0.13', dependencies: { 'fixture-dependency': '2.0.0' } }))
  fs.writeFileSync(path.join(root, 'bin', 'grok'), `#!/usr/bin/bash\n# ${marker}\n`)
  fs.chmodSync(path.join(root, 'bin', 'grok'), 0o700)
  fs.writeFileSync(path.join(root, 'node_modules', 'fixture-dependency', 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '2.0.0' }))
  fs.writeFileSync(path.join(root, 'node_modules', 'fixture-dependency', 'runtime.js'), `module.exports = ${JSON.stringify(marker)}\n`)
  return { root, executable: path.join(root, 'bin', 'grok') }
}

function copyFixture(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE })
  return path.join(target, 'bin', 'grok')
}

test('portable native identity stays stable after a package relocation and binds all dependency bytes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-portable-identity-'))
  try {
    const first = fixture(path.join(parent, 'first'))
    const relocated = copyFixture(first.root, path.join(parent, 'second', 'different-install-name'))
    const a = native.portableRuntimeDependencyIdentity('grok', first.executable, { PATH: '/usr/bin:/bin' })
    const b = native.portableRuntimeDependencyIdentity('grok', relocated, { PATH: '/usr/bin:/bin' })
    assert.deepEqual(a, b)
    assert.equal(a.schemaVersion, 1)
    assert.equal(a.provider, 'grok')
    assert.ok(a.files.some(([logical]) => logical === 'npm/@fixture/grok-build@1.0.13/package.json'))
    assert.ok(a.files.some(([logical]) => logical.endsWith('/node_modules/fixture-dependency@2.0.0/runtime.js')))
    assert.ok(a.files.some(([logical]) => logical === 'interpreter/bash'))
    assert.equal(a.fileCount, a.files.length)
    assert.equal(a.packageCount, 2)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('portable native identity changes for dependency bytes and rejects linked or missing dependency closures', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-portable-identity-'))
  try {
    const subject = fixture(parent)
    const before = native.portableRuntimeDependencyIdentity('grok', subject.executable, { PATH: '/usr/bin:/bin' })
    fs.appendFileSync(path.join(subject.root, 'node_modules', 'fixture-dependency', 'runtime.js'), '// changed\n')
    assert.notEqual(native.portableRuntimeDependencyIdentity('grok', subject.executable, { PATH: '/usr/bin:/bin' }).sha256, before.sha256)
    fs.rmSync(path.join(subject.root, 'node_modules', 'fixture-dependency'), { recursive: true, force: true })
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '2.0.0' }))
    fs.symlinkSync(outside, path.join(subject.root, 'node_modules', 'fixture-dependency'))
    assert.throws(() => native.portableRuntimeDependencyIdentity('grok', subject.executable, { PATH: '/usr/bin:/bin' }), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
    fs.rmSync(path.join(subject.root, 'node_modules', 'fixture-dependency'))
    assert.throws(() => native.portableRuntimeDependencyIdentity('grok', subject.executable, { PATH: '/usr/bin:/bin' }), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('portable identity resolves a required hoisted dependency and Prime-style declared tarball artifact', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-portable-hoisted-'))
  try {
    const install = path.join(parent, 'install'), runtime = path.join(install, 'node_modules', 'fixture-runtime')
    const dependency = path.join(install, 'node_modules', '@fixture', 'source-dependency')
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true, mode: 0o700 }); fs.mkdirSync(dependency, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', dependencies: { '@fixture/source-dependency': 'https://example.invalid/source-dependency-2.0.0.tgz' } }))
    fs.writeFileSync(path.join(runtime, 'bin', 'runtime'), '#!/usr/bin/bash\n'); fs.chmodSync(path.join(runtime, 'bin', 'runtime'), 0o700)
    fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'source-dependency', version: '2.0.0' }))
    fs.writeFileSync(path.join(dependency, 'runtime.js'), 'module.exports = 1\n')
    const identity = native.portableRuntimeDependencyIdentity('prime', path.join(runtime, 'bin', 'runtime'), { PATH: '/usr/bin:/bin' })
    assert.equal(identity.packageCount, 2)
    assert.ok(identity.files.some(([logical]) => logical.endsWith('/node_modules/source-dependency@2.0.0/runtime.js')))
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('portable identity binds env-selected interpreter bytes', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-portable-identity-'))
  try {
    const subject = fixture(parent)
    fs.writeFileSync(subject.executable, '#!/usr/bin/env bash\n# env interpreter\n')
    const identity = native.portableRuntimeDependencyIdentity('grok', subject.executable, { PATH: '/usr/bin:/bin' })
    assert.ok(identity.files.some(([logical]) => logical === 'interpreter/env'))
    assert.ok(identity.files.some(([logical]) => logical === 'interpreter/bash'))
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('portable identity binds an env-selected interpreter reached through a package-manager link', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-portable-env-link-'))
  try {
    const subject = fixture(parent)
    const runtime = path.join(parent, 'runtime')
    fs.mkdirSync(runtime, { mode: 0o700 })
    fs.symlinkSync('/usr/bin/bash', path.join(runtime, 'bun'))
    fs.writeFileSync(subject.executable, '#!/usr/bin/env bun\n# linked env interpreter\n')
    const identity = native.portableRuntimeDependencyIdentity('grok', subject.executable, { PATH: runtime })
    assert.ok(identity.files.some(([logical]) => logical === 'interpreter/bun'))
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('probe exposes the portable native identity without changing its local identity shape', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-portable-identity-'))
  try {
    const subject = fixture(parent)
    const probe = native.probeExecutable({ provider: 'grok', executable: subject.executable, env: { PATH: '/usr/bin:/bin' }, spawnSync: (_file, argv) => ({ status: 0, stdout: argv.includes('--version') ? 'grok 1.0.13\n' : '-p --output-format --resume --model --tools --verbatim --system-prompt-override --no-subagents\n', stderr: '' }) })
    assert.deepEqual(Object.keys(probe.runtimeIdentity).sort(), ['fileCount', 'packageCount', 'sha256'])
    assert.equal(probe.portableRuntimeIdentity.provider, 'grok')
    assert.equal(probe.portableRuntimeIdentity.schemaVersion, 1)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('Hermes portable identity canonicalizes only verified generated paths and their RECORD bindings', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-portable-'))
  const cp = require('node:child_process'), originalSpawnSync = cp.spawnSync
  try {
    const make = install => {
      const root = path.join(parent, install, 'project'), source = path.join(root, 'source'), packageRoot = path.join(source, 'hermes_cli'), site = path.join(root, 'site-packages'), bin = path.join(root, 'bin')
      fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(site, { recursive: true, mode: 0o700 }); fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
      const interpreter = path.join(bin, 'python'), executable = path.join(bin, 'hermes'), dist = path.join(site, 'hermes_agent-0.21.1.dist-info')
      fs.writeFileSync(interpreter, 'fixture interpreter\n'); fs.chmodSync(interpreter, 0o700)
      fs.writeFileSync(executable, `#!${interpreter}\nfixture launcher\n`); fs.chmodSync(executable, 0o700)
      fs.writeFileSync(path.join(packageRoot, 'runtime.py'), 'VALUE = 1\n')
      fs.writeFileSync(path.join(site, 'package.py'), 'PACKAGE = 1\n')
      fs.mkdirSync(dist)
      const finder = path.join(site, '__editable___hermes_agent_0_21_1_finder.py'), pth = path.join(site, '__editable__.hermes_agent-0.21.1.pth'), direct = path.join(dist, 'direct_url.json')
      fs.writeFileSync(finder, `MAPPING = {'hermes_cli': '${packageRoot}'}\n`)
      fs.writeFileSync(pth, `${packageRoot}\n`)
      fs.writeFileSync(direct, JSON.stringify({ dir_info: { editable: true }, url: `file://${source}` }))
      const b64 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64url')
      const record = path.join(dist, 'RECORD')
      fs.writeFileSync(record, [`../bin/hermes,sha256=${b64(executable)},${fs.statSync(executable).size}`, `${path.basename(finder)},sha256=${b64(finder)},${fs.statSync(finder).size}`, `${path.basename(pth)},sha256=${b64(pth)},${fs.statSync(pth).size}`, `${path.basename(dist)}/direct_url.json,sha256=${b64(direct)},${fs.statSync(direct).size}`, `${path.basename(dist)}/RECORD,,`].join('\n'))
      return { root, source, packageRoot, site, executable, interpreter, finder, pth, direct, record }
    }
    const first = make('first'), second = make('second')
    const inventory = subject => ({ files: [path.join(subject.packageRoot, 'runtime.py'), path.join(subject.site, 'package.py'), subject.finder, subject.pth, subject.direct, subject.record], packageCount: 1, missing: [], rootConflicts: [], generated: [
      { kind: 'editable-finder', path: subject.finder, references: [subject.packageRoot] }, { kind: 'editable-pth', path: subject.pth, references: [subject.packageRoot] }, { kind: 'direct-url', path: subject.direct, references: [`file://${subject.source}`] },
    ], roots: [{ logicalPath: 'editable/source/hermes', path: subject.source }, { logicalPath: 'editable/source/hermes/hermes_cli', path: subject.packageRoot }, { logicalPath: 'python/site-packages', path: subject.site }] })
    const queue = [inventory(first), inventory(second)]
    cp.spawnSync = () => ({ status: 0, stdout: JSON.stringify(queue.shift()), stderr: '' })
    const a = native.portableRuntimeDependencyIdentity('hermes', first.executable, { PATH: '/usr/bin:/bin' })
    const b = native.portableRuntimeDependencyIdentity('hermes', second.executable, { PATH: '/usr/bin:/bin' })
    assert.equal(a.sha256, b.sha256, 'equivalent generated installation paths must survive relocation')
    queue.push(inventory(first), inventory(second))
    assert.notEqual(native.hermesRuntimeDependencyIdentity(first.executable, { PATH: '/usr/bin:/bin' }).sha256, native.hermesRuntimeDependencyIdentity(second.executable, { PATH: '/usr/bin:/bin' }).sha256, 'local raw identity remains exact-path-bound')
    fs.appendFileSync(path.join(second.packageRoot, 'runtime.py'), '# changed\n')
    queue.push(inventory(second))
    assert.notEqual(native.portableRuntimeDependencyIdentity('hermes', second.executable, { PATH: '/usr/bin:/bin' }).sha256, b.sha256, 'runtime code remains byte-bound')
    const outside = path.join(parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'runtime.py'), 'VALUE = 1\n')
    const redirected = inventory(second); redirected.generated[0].references = [outside]
    queue.push(redirected)
    assert.throws(() => native.portableRuntimeDependencyIdentity('hermes', second.executable, { PATH: '/usr/bin:/bin' }), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
  } finally {
    cp.spawnSync = originalSpawnSync
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('Hermes inventory rejects linked editable files and linked editable roots', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-symlink-'))
  const cp = require('node:child_process'), originalSpawnSync = cp.spawnSync
  try {
    const root = path.join(parent, 'install'), bin = path.join(root, 'bin'), source = path.join(root, 'source'), site = path.join(root, 'site')
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(source); fs.mkdirSync(site)
    const interpreter = path.join(bin, 'python'), executable = path.join(bin, 'hermes'), runtime = path.join(source, 'runtime.py'), linked = path.join(source, 'linked.py')
    fs.writeFileSync(interpreter, 'python'); fs.chmodSync(interpreter, 0o700)
    fs.writeFileSync(executable, `#!${interpreter}\n`); fs.chmodSync(executable, 0o700)
    fs.writeFileSync(runtime, 'VALUE = 1\n'); fs.writeFileSync(path.join(site, 'package.py'), 'PACKAGE = 1\n')
    fs.symlinkSync(runtime, linked)
    const inventory = rootPath => ({ files: [linked, path.join(site, 'package.py')], packageCount: 1, missing: [], rootConflicts: [], roots: [{ logicalPath: 'editable/source', path: rootPath }, { logicalPath: 'python/site-packages', path: site }] })
    cp.spawnSync = () => ({ status: 0, stdout: JSON.stringify(inventory(source)), stderr: '' })
    assert.throws(() => native.portableRuntimeDependencyIdentity('hermes', executable, { PATH: '/usr/bin:/bin' }), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
    const linkedRoot = path.join(root, 'linked-source'); fs.symlinkSync(source, linkedRoot)
    cp.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ ...inventory(linkedRoot), files: [runtime, path.join(site, 'package.py')] }), stderr: '' })
    assert.throws(() => native.portableRuntimeDependencyIdentity('hermes', executable, { PATH: '/usr/bin:/bin' }), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
  } finally {
    cp.spawnSync = originalSpawnSync
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('Hermes actual Python inventory binds the approved OS stdlib links and rejects binding drift', { skip: !fs.existsSync('/tmp/autoprompt-hermes-v2-venv/bin/hermes') }, () => {
  const executable = '/tmp/autoprompt-hermes-v2-venv/bin/hermes'
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-hermes-shadow-')), previous = process.cwd()
  fs.writeFileSync(path.join(shadow, 'json.py'), 'raise RuntimeError("shadowed stdlib")\n')
  let captured
  try {
    process.chdir(shadow)
    captured = native.hermesPythonDependencyInventory(executable, { PATH: process.env.PATH })
  } finally {
    process.chdir(previous)
    fs.rmSync(shadow, { recursive: true, force: true })
  }
  assert.deepEqual(captured.links.map(link => link.logicalPath), [
    'python/stdlib-link/_sysconfigdata__linux_x86_64-linux-gnu.py',
    'python/stdlib-link/config-3.12-x86_64-linux-gnu/libpython3.12.so',
    'python/stdlib-link/sitecustomize.py',
  ])
  const baseline = native.hermesPortableRuntimeDependencyIdentity(executable, { PATH: process.env.PATH }, captured)
  assert.ok(baseline.files.some(([label]) => label === 'python/stdlib-link/sitecustomize.py'))
  const links = captured.links.map((link, index) => index ? link : { ...link, targetSha256: '0'.repeat(64) })
  assert.throws(() => native.hermesPortableRuntimeDependencyIdentity(executable, { PATH: process.env.PATH }, { ...captured, links }), error => error.code === 'PROVIDER_IDENTITY_MISMATCH')
})
