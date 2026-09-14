'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const closure = require('../../scripts/provider-closure.cjs')
const { parseArgs } = require('../../bin/autoprompt.cjs')

function fixtureRoot(sandbox) {
  const root = path.join(sandbox, 'omp-source')
  const bin = path.join(root, 'node_modules', 'bun', 'bin')
  const coding = path.join(root, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'dist')
  const shims = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
  fs.mkdirSync(coding, { recursive: true, mode: 0o700 })
  fs.mkdirSync(shims, { recursive: true, mode: 0o700 })
  fs.copyFileSync('/bin/true', path.join(bin, 'bun.exe'))
  fs.chmodSync(path.join(bin, 'bun.exe'), 0o700)
  fs.writeFileSync(path.join(coding, 'cli.js'), '#!/usr/bin/env bun\n', { mode: 0o700 })
  fs.symlinkSync('../bun/bin/bun.exe', path.join(shims, 'bun'))
  fs.symlinkSync('../@oh-my-pi/pi-coding-agent/dist/cli.js', path.join(shims, 'omp'))
  return root
}

let lastBubblewrapArgv = null
function fakeSpawn(command, argv) {
  if (command === '/usr/bin/bwrap') { lastBubblewrapArgv = argv; return { status: 0, stdout: 'omp/18.1.14\n', stderr: '' } }
  if (argv.length === 1 && argv[0] === '--version') return { status: 0, stdout: '1.3.14\n', stderr: '' }
  if (argv.length === 2 && argv[1] === '--version') return { status: 0, stdout: 'omp/18.1.14\n', stderr: '' }
  throw new Error(`unexpected closure probe ${command} ${JSON.stringify(argv)}`)
}

test('OMP closure preparation replaces Bun explicitly, binds its copied contents, and preserves a preexisting archive on rejection', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-provider-closure-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const source = fixtureRoot(sandbox)
  const output = path.join(sandbox, 'omp-import')
  const baseline = path.join(sandbox, 'baseline-bun')
  fs.copyFileSync('/bin/true', baseline); fs.chmodSync(baseline, 0o700)
  const result = closure.prepareOmpClosure({ source, bun: baseline, output, arch: 'x86_64', spawnSync: fakeSpawn })
  assert.equal(result.manifest.provider, 'omp')
  assert.equal(result.manifest.entrypoint.bunSha256,
    require('node:crypto').createHash('sha256').update(fs.readFileSync(baseline)).digest('hex'))
  assert.equal(closure.verifyOmpClosure({ root: output, relocation: false, spawnSync: fakeSpawn }).runtime.ompVersion,
    'omp/18.1.14')
  assert.equal(fs.readlinkSync(path.join(output, 'node_modules', '.bin', 'bun')), '../bun/bin/bun.exe')
  assert.ok(lastBubblewrapArgv.includes('--clearenv'), 'source-hidden witness must not inherit caller runtime controls')
  for (const name of ['PATH', 'HOME', 'LANG']) assert.ok(lastBubblewrapArgv.includes(name), `source-hidden witness must explicitly bind ${name}`)

  const existingArchive = path.join(sandbox, 'keep.tar')
  fs.writeFileSync(existingArchive, 'preserve-me', { mode: 0o600 })
  assert.throws(() => closure.prepareOmpClosure({ source, bun: baseline,
    output: path.join(sandbox, 'second-import'), archive: existingArchive, arch: 'x86_64', spawnSync: fakeSpawn }),
  { code: 'PROVIDER_CLOSURE_PATH_INVALID' })
  assert.equal(fs.readFileSync(existingArchive, 'utf8'), 'preserve-me')

  const linkedSandbox = path.join(sandbox, 'linked-source-fixture')
  fs.mkdirSync(linkedSandbox)
  const linkedSource = fixtureRoot(linkedSandbox)
  const linkedBun = path.join(linkedSource, 'node_modules', 'bun', 'bin', 'bun.exe')
  fs.unlinkSync(linkedBun)
  fs.symlinkSync('/bin/true', linkedBun)
  const rejectedOutput = path.join(sandbox, 'linked-output')
  assert.throws(() => closure.prepareOmpClosure({ source: linkedSource, bun: baseline,
    output: rejectedOutput, arch: 'x86_64', spawnSync: fakeSpawn }), { code: 'PROVIDER_CLOSURE_INVALID' })
  assert.equal(fs.existsSync(rejectedOutput), false,
    'an escaping copied Bun path must be rejected before it can become a write destination')
})

test('OMP closure parser exposes the public explicit baseline Bun contract', () => {
  const source = '/private/omp-source', bun = '/private/bun/bun', output = '/private/omp-import'
  assert.deepEqual(parseArgs(['runtime', 'closure', 'prepare', 'omp', '--source', source,
    '--bun', bun, '--output', output, '--arch', 'x86_64']), {
    command: 'runtime-closure', action: 'prepare', provider: 'omp', source, bun, output, arch: 'x86_64',
  })
  assert.throws(() => parseArgs(['runtime', 'closure', 'prepare', 'omp', '--source', source,
    '--output', output, '--arch', 'x86_64']), /requires --bun/)
})
