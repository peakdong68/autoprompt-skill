'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const setup = require('../../scripts/darwin-runtime-setup.cjs')
const activation = require('../../scripts/codex-configure.cjs')

test('native Darwin helper cleanup binds exact platform links and setup Python flock', {
  skip: process.platform !== 'darwin' || process.env.AUTOPROMPT_REAL_DARWIN_FILESYSTEM !== '1',
}, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-codex-helper-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'provider'), activationRoot = path.join(base, 'activation')
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(activationRoot, { mode: 0o700 })
  const python = process.env.AUTOPROMPT_DARWIN_PYTHON
  setup.setup({ provider: 'codex', root, python, packageRoot: path.resolve(__dirname, '../..') })
  const closure = setup.bindActivation({ provider: 'codex', root, activationRoot })
  const executable = path.join(base, 'codex'); fs.writeFileSync(executable, 'fixture', { mode: 0o600 })
  const bundle = path.join(activationRoot, 'tmp', 'arg0', 'codex-arg0Native123')
  fs.mkdirSync(bundle, { recursive: true, mode: 0o700 })
  const lock = path.join(bundle, '.lock'); fs.writeFileSync(lock, '', { mode: 0o600 })
  for (const name of ['apply_patch', 'applypatch', 'codex-execve-wrapper']) fs.symlinkSync(executable, path.join(bundle, name))
  fs.symlinkSync(executable, path.join(bundle, 'codex-linux-sandbox'))
  assert.throws(() => activation.removeInactiveCodexProbeHelpers(activationRoot, executable, closure), /codex-probe-helper-unrecognized/)
  fs.unlinkSync(path.join(bundle, 'codex-linux-sandbox'))
  assert.throws(() => activation.removeInactiveCodexProbeHelpers(activationRoot, executable), /codex-probe-helper-lock-runtime-required/)
  const holder = childProcess.spawn(python, ['-I', '-S', '-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"r+");fcntl.flock(f,fcntl.LOCK_EX);print("ready",flush=True);time.sleep(30)', lock], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => { try { holder.kill() } catch {} })
  await new Promise((resolve, reject) => { holder.once('error', reject); holder.stdout.once('data', resolve) })
  assert.throws(() => activation.removeInactiveCodexProbeHelpers(activationRoot, executable, closure), /codex-probe-helper-lock-busy/)
  const ended = new Promise(resolve => holder.once('close', resolve)); holder.kill(); await ended
  assert.equal(activation.removeInactiveCodexProbeHelpers(activationRoot, executable, closure), 1)
  assert.equal(fs.existsSync(bundle), false)
})
