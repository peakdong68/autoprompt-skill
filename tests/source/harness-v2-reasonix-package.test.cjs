'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const test = require('node:test')
const pkg = require('../../scripts/reasonix-package.cjs')

function fixture(t, suffix = 'config') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-package-recovery-'))
  t.after(() => { t.mock.restoreAll(); fs.rmSync(temporary, { recursive: true, force: true }) })
  return path.join(temporary, suffix)
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
function transactions(root) { return path.join(root, '.autoprompt-private', 'transactions') }
function failCleanup(t, root) {
  const unlink = fs.unlinkSync
  let calls = 0, captured
  const mocked = t.mock.method(fs, 'unlinkSync', (file, ...args) => {
    if (String(file).includes(`${path.sep}transactions${path.sep}reasonix-remove-`) && String(file).includes(`${path.sep}bundle${path.sep}`) && ++calls === 2) {
      throw Object.assign(new Error('injected private cleanup interruption'), { code: 'EACCES' })
    }
    return unlink(file, ...args)
  })
  assert.throws(() => pkg.uninstall(root), error => {
    captured = error
    assert.equal(error.code, 'INSTALL_CLEANUP_REQUIRED')
    assert.equal(error.details.operationCommitted, true)
    return true
  })
  mocked.mock.restore()
  assert.equal(calls, 2)
  return captured.details.recoveryPath
}

test('Reasonix launcher binds custom roots and quotes them without shell expansion', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t, "a root's $(printf INJECTED) directory")
  pkg.install(root)
  const launcher = fs.readFileSync(path.join(root, 'skills/autoprompt/SKILL.md'), 'utf8')
  assert.equal(launcher, pkg.launcher(root))
  const command = launcher.match(/```sh\n([^\n]+)\n```/)[1]
    .replace('<absolute-project-path>', "'/test-target'").replace('<mission>', "'exact mission'")
  const result = cp.spawnSync('bash', ['--noprofile', '--norc', '-c', `autoprompt() { printf '%s\\0' "$@"; }; ${command}`], { encoding: 'utf8', env: { PATH: process.env.PATH } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), ['activate', 'reasonix', '--root', root, '--target', '/test-target', '--', 'exact mission'])
  assert.ok(launcher.includes(`--root '${root.replaceAll("'", "''")}'`))
  for (const invalid of ['relative', '/', `${root}\nother`]) assert.throws(() => pkg.launcher(invalid), { code: 'INSTALL_ROOT_INVALID' })
  pkg.uninstall(root)
})

test('Reasonix migrates the exact previous v2 launcher without accepting a modified launcher', t => {
  const root = fixture(t), installed = pkg.install(root), entry = path.join(root, 'skills/autoprompt/SKILL.md')
  fs.writeFileSync(entry, pkg.SHIM)
  assert.throws(() => pkg.verify(root), { code: 'PAYLOAD_INVALID' })
  assert.equal(pkg.install(root).payloadDigest, installed.payloadDigest)
  assert.equal(fs.readFileSync(entry, 'utf8'), pkg.launcher(root))
  fs.writeFileSync(entry, `${pkg.SHIM}custom instructions`)
  assert.throws(() => pkg.install(root), { code: 'PAYLOAD_INVALID' })
  assert.equal(fs.readFileSync(entry, 'utf8'), `${pkg.SHIM}custom instructions`)
})

test('Reasonix verification and idempotent install reject reintroduced legacy and private roles', t => {
  const root = fixture(t)
  pkg.install(root)
  const notes = path.join(root, 'skills/personal/SKILL.md'); write(notes, 'unrelated personal skill')
  for (const name of ['ap-manager', 'ap-worker', 'ap-independent-checker']) {
    const role = path.join(root, 'skills', name, 'SKILL.md'); write(role, 'public role must not be discovered')
    assert.throws(() => pkg.verify(root), { code: 'PAYLOAD_INVALID' })
    assert.throws(() => pkg.install(root), { code: 'PAYLOAD_INVALID' })
    assert.equal(fs.readFileSync(role, 'utf8'), 'public role must not be discovered')
    fs.unlinkSync(role)
  }
  assert.equal(pkg.install(root).status, 'verified')
  pkg.uninstall(root)
  assert.equal(fs.readFileSync(notes, 'utf8'), 'unrelated personal skill')
})

test('Reasonix failed removal publication restores the complete active installation', t => {
  const root = fixture(t), installed = pkg.install(root), entry = path.join(root, 'skills/autoprompt/SKILL.md')
  const rename = fs.renameSync
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === entry) throw Object.assign(new Error('injected entry retirement failure'), { code: 'EACCES' })
    return rename(from, to)
  })
  assert.throws(() => pkg.uninstall(root), { code: 'EACCES' })
  mocked.mock.restore()
  assert.equal(pkg.verify(root).payloadDigest, installed.payloadDigest)
  assert.deepEqual(fs.readdirSync(transactions(root)), [])
  pkg.uninstall(root)
})

test('Reasonix recovers an interrupted precommit rollback before idempotent reinstall', t => {
  const root = fixture(t), installed = pkg.install(root), entry = path.join(root, 'skills/autoprompt/SKILL.md')
  const rename = fs.renameSync
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === entry || to === installed.bundle) throw Object.assign(new Error('injected publication and rollback interruption'), { code: 'EACCES' })
    return rename(from, to)
  })
  assert.throws(() => pkg.uninstall(root), { code: 'INSTALL_RECOVERY_REQUIRED' })
  mocked.mock.restore()
  assert.equal(fs.existsSync(installed.bundle), false)
  assert.equal(fs.existsSync(path.join(root, pkg.RECEIPT)), true)
  assert.equal(pkg.install(root).payloadDigest, installed.payloadDigest)
  assert.deepEqual(fs.readdirSync(transactions(root)), [])
  pkg.uninstall(root)
})

test('Reasonix interrupted postcommit cleanup never leaves a half-deleted active package', t => {
  const root = fixture(t), installed = pkg.install(root)
  const personal = path.join(root, 'config.toml'); fs.writeFileSync(personal, 'default_model = "personal"\n')
  const pending = failCleanup(t, root)
  assert.equal(fs.existsSync(installed.bundle), false)
  assert.equal(fs.existsSync(path.join(root, pkg.RECEIPT)), false)
  assert.equal(fs.existsSync(path.join(root, 'skills/autoprompt/SKILL.md')), false)
  assert.equal(fs.existsSync(path.join(pending, 'committed.json')), true)
  assert.equal(pkg.install(root).payloadDigest, installed.payloadDigest)
  assert.deepEqual(fs.readdirSync(transactions(root)), [])
  assert.equal(fs.readFileSync(personal, 'utf8'), 'default_model = "personal"\n')
  pkg.uninstall(root)
})

test('Reasonix retained cleanup refuses unowned files and allows retry after the conflict is removed', t => {
  const root = fixture(t); pkg.install(root)
  const pending = failCleanup(t, root), foreign = path.join(pending, 'bundle', 'personal.txt')
  fs.writeFileSync(foreign, 'never delete unowned data')
  assert.throws(() => pkg.install(root), { code: 'INSTALL_RECOVERY_REQUIRED' })
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'never delete unowned data')
  fs.unlinkSync(foreign)
  assert.equal(pkg.uninstall(root).status, 'not-installed')
  assert.deepEqual(fs.readdirSync(transactions(root)), [])
  assert.equal(pkg.install(root).status, 'verified')
  pkg.uninstall(root)
})
