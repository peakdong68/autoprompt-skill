'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const test = require('node:test')
const pkg = require('../../scripts/harness-v2-package.cjs')
const { acquire, release } = require('../../scripts/install/operation-lock.cjs')
const ROOT = path.resolve(__dirname, '../..')
const CLI = path.join(ROOT, 'scripts/harness-v2-package.cjs')
const BINARIES = { claude: ['claude', '2.1.141'], opencode: ['opencode', '1.5.7'], kilo: ['kilo', '7.1.0'], vscode: ['code', '1.133.0'], prime: ['prime-agent', '0.7.2'], omp: ['omp', '17.4.0'], deepseek: ['dsh', '0.1.0-rc.7'] }
function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-v2-lifecycle-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
function run(file, args, env, cwd = ROOT) { return cp.spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', cwd, env, timeout: 120000 }) }
function ok(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`); return result }
const original = require('../helpers/legacy-provider-fixture.cjs').readLegacyFixture
function versionEnvironment(directory, provider, root) {
  const bin = path.join(directory, 'bin')
  const [name, version] = BINARIES[provider]
  const executable = path.join(bin, name)
  // This sentinel permits only a version probe. Any native workload invocation fails.
  write(executable, `#!/bin/sh\ncase "$1" in --version|-v) printf '%s\\n' '${version}' ;; *) echo 'VERSION PROBE ONLY' >&2; exit 93 ;; esac\n`)
  fs.chmodSync(executable, 0o700)
  return { ...process.env, HOME: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'xdg'), AUTOPROMPT_INSTALL_ROOT: root, PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter) }
}
function cloneSource(directory) {
  const source = path.join(directory, 'source')
  for (const relative of ['agents/codex', 'agents/contracts', 'agents/claude', 'agents/reasonix/workflow', 'scripts']) fs.cpSync(path.join(ROOT, relative), path.join(source, relative), { recursive: true })
  const toml = path.dirname(require.resolve('@iarna/toml/package.json'))
  const yaml = path.dirname(require.resolve('yaml/package.json'))
  fs.cpSync(toml, path.join(source, 'node_modules/@iarna/toml'), { recursive: true })
  fs.cpSync(yaml, path.join(source, 'node_modules/yaml'), { recursive: true })
  return source
}

test('native config roots and manual discovery destinations use provider roots', () => {
  const home = path.resolve(os.tmpdir(), 'v2-roots-home')
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), AUTOPROMPT_WORKSPACE_ROOT: path.join(home, 'project') }
  const expected = { claude: '.claude', opencode: 'xdg/opencode', kilo: 'xdg/kilo', vscode: '.copilot', prime: '.prime/agent', omp: '.omp/agent', deepseek: '.dsh' }
  for (const provider of pkg.PROVIDERS) {
    assert.equal(pkg.resolveRoot(provider, env), path.join(home, expected[provider]))
    assert.equal(pkg.resolveRoot(provider, { ...env, AUTOPROMPT_INSTALL_ROOT: path.join(home, 'override') }), path.join(home, 'override'))
  }
  assert.equal(pkg.resolveRoot('omp', { HOME: home, OMP_PROFILE: 'work' }), path.join(home, '.omp/profiles/work/agent'))
  assert.throws(() => pkg.resolveRoot('omp', { HOME: home, OMP_PROFILE: '../escape' }), /Invalid OMP/)
  assert.throws(() => pkg.resolveRoot('claude', { AUTOPROMPT_INSTALL_ROOT: '' }), /absolute/)
  assert.throws(() => pkg.run(['install', 'codex']), /Use harness/)
  assert.throws(() => pkg.run(['install', 'claude', '--root', '/']), /filesystem root/)
  assert.equal(pkg.launcherRelative('vscode'), 'skills/autoprompt/SKILL.md')
  assert.equal(pkg.launcherRelative('prime'), 'skills/autoprompt/SKILL.md')
})

test('macOS home and provider overrides resolve without assuming Linux XDG directories', { skip: process.platform === 'win32' }, () => {
  const home = '/Users/Example User'
  const env = { HOME: home }
  const expected = { claude: '.claude', opencode: '.config/opencode', kilo: '.config/kilo', vscode: '.copilot', prime: '.prime/agent', omp: '.omp/agent', deepseek: '.dsh' }
  for (const provider of pkg.PROVIDERS) assert.equal(pkg.resolveRoot(provider, env), path.join(home, expected[provider]))
  assert.equal(pkg.resolveRoot('claude', { ...env, CLAUDE_CONFIG_DIR: `${home}/Library/Application Support/Claude` }), `${home}/Library/Application Support/Claude`)
  assert.equal(pkg.resolveRoot('omp', { ...env, PI_CONFIG_DIR: `${home}/Library/Application Support/OMP`, OMP_PROFILE: 'work' }), `${home}/Library/Application Support/OMP/profiles/work/agent`)
})

for (const provider of pkg.PROVIDERS) test(`${provider}: actual closure, idempotence and removal preserve custom files and config`, t => {
  const directory = context(t), root = path.join(directory, 'config')
  write(path.join(root, 'config.json'), '{"custom":true}\n')
  write(path.join(root, 'agents/custom.md'), 'custom role\n')
  const installed = pkg.install(provider, root)
  assert.equal(installed.provider, provider)
  const labels = Object.fromEntries(require('../../bin/autoprompt.cjs').PROVIDERS.map(item => [item.id, item.label]))
  const compat = require('../../bin/provider-root-compat.cjs').createProviderRootCompat(labels)
  assert.deepEqual(compat.inspect(root, provider), { status: 'accept' })
  assert.match(installed.payloadGeneration, new RegExp(`^${provider}-v2\\.0\\.0-[a-f0-9]{16}$`))
  for (const tree of ['agents/codex/', 'agents/contracts/', `agents/${provider}/`, 'agents/reasonix/workflow/', 'node_modules/@iarna/toml/', 'node_modules/yaml/']) assert.ok(Object.keys(installed.files).some(file => file.startsWith(tree)), tree)
  for (const module of ['package', 'configure', 'native', 'transport']) assert.ok(installed.files[`scripts/harness-v2-${module}.cjs`])
  const roles = Object.keys(installed.files).filter(file => file.startsWith('agents/codex/agents/') && file.endsWith('.toml'))
  assert.equal(roles.length, 32)
  assert.deepEqual(fs.readdirSync(path.join(root, 'agents')), ['custom.md'])
  assert.match(fs.readFileSync(pkg.launcherPath(provider, root), 'utf8'), new RegExp(`autoprompt activate ${provider} --target`))
  assert.ok(fs.readFileSync(pkg.launcherPath(provider, root), 'utf8').includes(JSON.stringify(root)))
  assert.match(fs.readFileSync(pkg.launcherPath(provider, root), 'utf8'), new RegExp(`autoprompt activate ${provider} --root`))
  const publicLaunchers = pkg.walk(root).filter(file => !file.startsWith('.autoprompt-private/') && /(?:SKILL\.md|autoprompt\.md|autoprompt\.prompt\.md)$/.test(file))
  assert.deepEqual(publicLaunchers, [pkg.launcherRelative(provider)])
  const receipt = fs.readFileSync(path.join(root, pkg.receiptName(provider)))
  assert.equal(pkg.install(provider, root).payloadGeneration, installed.payloadGeneration)
  assert.deepEqual(fs.readFileSync(path.join(root, pkg.receiptName(provider))), receipt)
  // The installed helper must load without reaching into this repository.
  ok(run(path.join(installed.bundle, 'scripts/harness-v2-package.cjs'), ['verify', provider, '--root', root]))
  assert.equal(pkg.uninstall(provider, root).status, 'uninstalled')
  assert.equal(pkg.uninstall(provider, root).status, 'not-installed')
  assert.equal(fs.readFileSync(path.join(root, 'agents/custom.md'), 'utf8'), 'custom role\n')
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"custom":true}\n')
  assert.equal(fs.existsSync(installed.bundle), false)
  assert.equal(fs.existsSync(pkg.launcherPath(provider, root)), false)
})

test('migration uses original HEAD bytes and quarantines recursive roles plus skill resources', t => {
  const root = path.join(context(t), 'config')
  const role = original('agents/claude/agents/ap-manager.md')
  const skill = original('agents/claude/SKILL.md')
  write(path.join(root, 'agents/ap-manager.md'), role)
  write(path.join(root, 'skills/autoprompt/agents/ap-manager.md'), role)
  write(path.join(root, 'skills/autoprompt/SKILL.md'), skill)
  write(path.join(root, 'skills/autoprompt/custom.txt'), 'leave me')
  const result = pkg.install('claude', root)
  assert.equal(result.migrated.length, 3)
  assert.equal(fs.existsSync(path.join(root, 'agents/ap-manager.md')), false)
  assert.deepEqual(fs.readFileSync(path.join(root, '.autoprompt-private/legacy-v1/claude/agents/ap-manager.md')), role)
  pkg.uninstall('claude', root)
  assert.equal(fs.readFileSync(path.join(root, 'skills/autoprompt/custom.txt'), 'utf8'), 'leave me')
  assert.equal(fs.existsSync(path.join(root, '.autoprompt-private/legacy-v1/claude/skills/autoprompt/SKILL.md')), true)
})

test('changed legacy files and unowned public targets are refused without replacement', t => {
  const directory = context(t)
  for (const [index, relative] of ['agents/ap-manager.md', 'skills/autoprompt/SKILL.md'].entries()) {
    const root = path.join(directory, String(index))
    write(path.join(root, relative), 'custom changed content')
    assert.throws(() => pkg.install('claude', root), /legacy file|Unowned launcher/)
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'custom changed content')
    assert.equal(fs.existsSync(path.join(root, pkg.receiptName('claude'))), false)
  }
  const root = path.join(directory, 'opencode')
  write(pkg.launcherPath('opencode', root), 'custom command')
  assert.throws(() => pkg.install('opencode', root), /Unowned launcher/)
})

test('payload, receipt, launcher, hard links and unexpected bundle files fail closed', t => {
  const root = path.join(context(t), 'config')
  const installed = pkg.install('claude', root)
  const victim = path.join(installed.bundle, 'agents/claude/VERSION')
  const originalBytes = fs.readFileSync(victim)
  fs.writeFileSync(victim, 'tampered')
  const labels = Object.fromEntries(require('../../bin/autoprompt.cjs').PROVIDERS.map(item => [item.id, item.label]))
  const compat = require('../../bin/provider-root-compat.cjs').createProviderRootCompat(labels)
  assert.equal(compat.inspect(root, 'claude').status, 'warn')
  for (const call of [() => pkg.verify('claude', root), () => pkg.uninstall('claude', root), () => pkg.install('claude', root)]) assert.throws(call, /Payload changed/)
  fs.writeFileSync(victim, originalBytes)
  const linked = path.join(root, 'user-hardlink')
  fs.linkSync(victim, linked)
  assert.throws(() => pkg.verify('claude', root), /one regular file/)
  fs.unlinkSync(linked)
  write(path.join(installed.bundle, 'unexpected.txt'), 'custom')
  assert.throws(() => pkg.uninstall('claude', root), /inventory drifted/)
  fs.unlinkSync(path.join(installed.bundle, 'unexpected.txt'))
  const launcher = pkg.launcherPath('claude', root), launcherBytes = fs.readFileSync(launcher)
  fs.writeFileSync(launcher, 'changed launcher')
  assert.throws(() => pkg.verify('claude', root), /launcher changed/)
  fs.writeFileSync(launcher, launcherBytes)
  const receipt = path.join(root, pkg.receiptName('claude')), receiptBytes = fs.readFileSync(receipt)
  fs.writeFileSync(receipt, JSON.stringify({ ...installed, payloadGeneration: 'claude-v2.0.0-../../escape' }))
  assert.throws(() => pkg.uninstall('claude', root), /receipt is invalid/)
  fs.writeFileSync(receipt, receiptBytes)
  pkg.uninstall('claude', root)
})

test('symlink roots, ancestors, dangling discovery links and source links are refused', t => {
  const directory = context(t), outside = path.join(directory, 'outside')
  fs.mkdirSync(outside)
  const link = path.join(directory, 'linked')
  fs.symlinkSync(outside, link, 'dir')
  assert.throws(() => pkg.install('claude', link), /linked|Linked/)
  assert.throws(() => pkg.install('claude', path.join(link, 'child')), /linked|Linked/)
  const root = path.join(directory, 'root')
  fs.mkdirSync(root)
  fs.symlinkSync(path.join(directory, 'missing'), path.join(root, 'skills'), 'dir')
  assert.throws(() => pkg.install('claude', root), /EEXIST|linked|Linked|symlink/)
  assert.equal(fs.readdirSync(outside).length, 0)
})

test('active and WAITING_USER runs block mutation, while unrelated providers and completed history survive', t => {
  const directory = context(t), root = path.join(directory, 'config')
  const installed = pkg.install('claude', root)
  const record = path.join(root, '.autoprompt-private/activations/one/activation.json')
  write(record, JSON.stringify({ providerId: 'claude', status: 'active' }))
  assert.throws(() => pkg.uninstall('claude', root), /resumable/)
  write(record, JSON.stringify({ providerId: 'claude', status: 'revoked', outcome: 'WAITING_USER' }))
  assert.throws(() => pkg.uninstall('claude', root), /resumable/)
  write(record, JSON.stringify({ providerId: 'opencode', status: 'active' }))
  assert.equal(pkg.uninstall('claude', root).status, 'uninstalled')
  assert.equal(fs.existsSync(record), true)
  assert.equal(fs.existsSync(installed.bundle), false)
})

test('update publishes a new generation and refuses active-run updates', t => {
  const directory = context(t), root = path.join(directory, 'config'), source = cloneSource(directory)
  const first = pkg.install('claude', root, source)
  fs.appendFileSync(path.join(source, 'scripts/harness-v2-package.cjs'), '\n// Updated package fixture.\n')
  const record = path.join(root, '.autoprompt-private/activations/run/activation.json')
  write(record, JSON.stringify({ providerId: 'claude', status: 'active' }))
  assert.throws(() => pkg.install('claude', root, source), /resumable/)
  assert.equal(pkg.verify('claude', root).payloadGeneration, first.payloadGeneration)
  write(record, JSON.stringify({ providerId: 'claude', status: 'revoked', outcome: 'COMPLETE' }))
  const updated = pkg.install('claude', root, source)
  assert.notEqual(updated.payloadGeneration, first.payloadGeneration)
  assert.equal(fs.existsSync(first.bundle), false)
  assert.equal(fs.existsSync(updated.bundle), true)
})

test('publication faults roll back migration, first install, update, and uninstall', t => {
  const directory = context(t), root = path.join(directory, 'config'), source = cloneSource(directory)
  const legacy = original('agents/claude/agents/ap-manager.md')
  write(path.join(root, 'agents/ap-manager.md'), legacy)
  function fault(call, predicate) {
    const rename = fs.renameSync
    let injected = false
    fs.renameSync = (from, to) => {
      if (!injected && predicate(from, to)) { injected = true; throw new Error('publication fault') }
      return rename(from, to)
    }
    try { assert.throws(call, /publication fault/) } finally { fs.renameSync = rename }
    assert.equal(injected, true)
  }
  fault(() => pkg.install('claude', root, source), (_, to) => to === path.join(root, pkg.receiptName('claude')))
  assert.deepEqual(fs.readFileSync(path.join(root, 'agents/ap-manager.md')), legacy)
  assert.equal(fs.existsSync(pkg.launcherPath('claude', root)), false)
  const first = pkg.install('claude', root, source)
  fs.appendFileSync(path.join(source, 'scripts/harness-v2-package.cjs'), '\n// update fixture\n')
  fault(() => pkg.install('claude', root, source), (_, to) => to === path.join(root, pkg.receiptName('claude')))
  assert.equal(pkg.verify('claude', root).payloadGeneration, first.payloadGeneration)
  fault(() => pkg.uninstall('claude', root), from => from === pkg.launcherPath('claude', root))
  assert.equal(pkg.verify('claude', root).payloadGeneration, first.payloadGeneration)
  pkg.uninstall('claude', root)
})

test('operation leases reject concurrent lifecycle mutation', t => {
  const root = path.join(context(t), 'config')
  pkg.install('claude', root)
  const lease = acquire(root, 'test-owner')
  try { assert.throws(() => pkg.uninstall('claude', root), /operation lock is held/) } finally { release(lease) }
  pkg.uninstall('claude', root)
})

for (const provider of pkg.PROVIDERS) test(`${provider}: public package process and shell lifecycle use private v2 only`, { skip: process.platform === 'win32' }, t => {
  const directory = context(t), root = path.join(directory, 'config'), env = versionEnvironment(directory, provider, root)
  for (const [script, args] of [['install', []], ['doctor', ['--strict']], ['uninstall', []]]) {
    const result = cp.spawnSync('bash', [path.join(ROOT, 'scripts/install', `${script}.sh`), provider, ...args], { encoding: 'utf8', cwd: directory, env, timeout: 120000 })
    ok(result)
    if (script === 'install') {
      ok(run(CLI, ['verify', provider, '--root', root], env, directory))
      assert.equal(fs.existsSync(path.join(root, '.autoprompt-install-receipt.json')), false)
      assert.equal(fs.existsSync(path.join(root, 'agents/ap-manager.md')), false)
    }
  }
  assert.equal(fs.existsSync(pkg.launcherPath(provider, root)), false)
})

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const hasPowerShell = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0
test('PowerShell entrypoints parse and route all seven providers to the private lifecycle', { skip: !hasPowerShell }, () => {
  const files = ['install', 'doctor', 'uninstall', 'harness-v2'].map(name => path.join(ROOT, 'scripts/install', `${name}.ps1`))
  const command = files.map(file => `$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if ($errors.Count) { throw ($errors | Out-String) }`).join('; ')
  const result = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
  ok(result)
})

for (const provider of pkg.PROVIDERS) test(`${provider}: PowerShell installs, verifies and removes its private v2 payload`, { skip: !hasPowerShell || process.platform === 'win32' }, t => {
  const directory = context(t), root = path.join(directory, 'config with spaces'), env = versionEnvironment(directory, provider, root)
  for (const [script, extra] of [['install', []], ['doctor', ['-Strict']], ['uninstall', []]]) {
    const result = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts/install', `${script}.ps1`), provider, ...extra],
      { encoding: 'utf8', cwd: directory, env, timeout: 120000 })
    ok(result)
    if (script === 'install') {
      ok(run(CLI, ['verify', provider, '--root', root], env, directory))
      assert.equal(fs.existsSync(path.join(root, 'agents/ap-manager.md')), false)
    }
  }
  assert.equal(fs.existsSync(pkg.launcherPath(provider, root)), false)
})

test('reasonix: PowerShell installs, verifies and removes its private v2 payload', { skip: !hasPowerShell || process.platform === 'win32' }, t => {
  const directory = context(t), root = path.join(directory, 'reasonix config with spaces')
  const env = versionEnvironment(directory, 'claude', root)
  const binary = path.join(directory, 'bin/reasonix')
  write(binary, '#!/bin/sh\ncase "$1" in --version|-v) printf "%s\\n" "reasonix v1.30.0" ;; *) exit 93 ;; esac\n')
  fs.chmodSync(binary, 0o700)
  const reasonix = require('../../scripts/reasonix-package.cjs')
  let installed
  for (const [script, extra] of [['install', []], ['doctor', ['-Strict']], ['uninstall', []]]) {
    ok(cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts/install', `${script}.ps1`), 'reasonix', ...extra],
      { encoding: 'utf8', cwd: directory, env, timeout: 120000 }))
    if (script === 'install') installed = reasonix.verify(root)
  }
  assert.equal(fs.existsSync(reasonix.bundlePath(root, installed)), false)
  assert.equal(fs.existsSync(path.join(root, reasonix.RECEIPT)), false)
})
