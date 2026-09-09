'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const workflow = path.resolve(__dirname, '../../agents/codex/workflow')
const { hashDirectoryStateStrict } = require(path.join(workflow, 'runtime-state.js'))
const { candidateExternalLocalResources, hashWorkspaceCandidate } = require(path.join(workflow, 'phase-budget.js'))
const linux = process.platform === 'linux'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-tree-race-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tree = path.join(root, 'tree')
  fs.mkdirSync(tree)
  fs.writeFileSync(path.join(tree, 'a'), 'old-a', { mode: 0o600 })
  fs.writeFileSync(path.join(tree, 'b'), 'old-b', { mode: 0o600 })
  return { root, tree }
}

function mutateBeforeB(tree, original) {
  let changed = false
  return function (file, ...args) {
    if (!changed && path.basename(String(file)) === 'b') {
      changed = true
      fs.writeFileSync(path.join(tree, 'a'), 'new-a')
      fs.writeFileSync(path.join(tree, 'b'), 'new-b')
    }
    return original(file, ...args)
  }
}

test('strict manifest tree capture rejects a mixture of file versions that never existed', { skip: !linux }, t => {
  const { tree } = fixture(t)
  const observed = Object.create(fs)
  observed.lstatSync = mutateBeforeB(tree, fs.lstatSync)
  assert.throws(() => hashDirectoryStateStrict(tree, observed), { code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.readFileSync(path.join(tree, 'a'), 'utf8'), 'new-a')
  assert.equal(fs.readFileSync(path.join(tree, 'b'), 'utf8'), 'new-b')
})

test('public external-local candidate hashing rejects the same mixed tree', { skip: !linux }, t => {
  const { root, tree } = fixture(t)
  const target = path.join(root, 'target')
  fs.mkdirSync(target)
  for (const args of [['init', '--initial-branch=fixture'], ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'], ['commit', '--allow-empty', '-m', 'fixture']]) {
    const result = cp.spawnSync('git', args, { cwd: target, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const resources = candidateExternalLocalResources([
    { kind: 'directory', identity: tree, owner: 'worker-1', ownershipMode: 'single-owner' },
  ], target, `Create the exact directory output \`${tree}\`.`)
  const original = fs.lstatSync
  fs.lstatSync = mutateBeforeB(tree, original)
  try {
    assert.throws(() => hashWorkspaceCandidate(target, process.env, resources), { code: 'PREIMAGE_UNSAFE' })
  } finally { fs.lstatSync = original }
  assert.equal(fs.readFileSync(path.join(tree, 'b'), 'utf8'), 'new-b')
})

test('strict capture rereads actual bytes when dirty mmap changes preserve metadata', { skip: !linux }, t => {
  const { root, tree } = fixture(t)
  const nodeRunner = path.join(root, 'capture.cjs')
  const pythonRunner = path.join(root, 'writer.py')
  fs.writeFileSync(nodeRunner, [
    "const fs = require('node:fs'), path = require('node:path')",
    `const { hashDirectoryStateStrict } = require(${JSON.stringify(path.join(workflow, 'runtime-state.js'))})`,
    'const observed = Object.create(fs); let changed = false',
    'observed.lstatSync = (file, ...args) => {',
    "  if (!changed && path.basename(String(file)) === 'b') {",
    "    changed = true; fs.writeSync(1, 'MUTATE\\n')",
    "    if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw Error('writer closed')",
    '  }',
    '  return fs.lstatSync(file, ...args)',
    '}',
    `try { hashDirectoryStateStrict(${JSON.stringify(tree)}, observed); fs.writeSync(1, JSON.stringify({ accepted: true }) + '\\n') }`,
    "catch (error) { fs.writeSync(1, JSON.stringify({ code: error.code }) + '\\n') }",
  ].join('\n'))
  fs.writeFileSync(pythonRunner, [
    'import json, mmap, os, subprocess',
    `source=os.open(${JSON.stringify(path.join(tree, 'a'))}, os.O_RDWR)`,
    "mapped=mmap.mmap(source, 5); mapped[:]=b'old-a'",
    `child=subprocess.Popen([${JSON.stringify(process.execPath)}, ${JSON.stringify(nodeRunner)}], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)`,
    'try:',
    "  assert child.stdout.readline() == 'MUTATE\\n'",
    `  before=os.fstat(source)`,
    "  mapped[:]=b'new-a'",
    `  with open(${JSON.stringify(path.join(tree, 'b'))}, 'wb') as target: target.write(b'new-b')`,
    '  after=os.fstat(source)',
    "  child.stdin.write('1'); child.stdin.flush()",
    '  result=json.loads(child.stdout.readline())',
    '  assert child.wait(timeout=10) == 0, child.stderr.read()',
    "  result['metadataUnchanged']=(before.st_mtime_ns, before.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns)",
    '  print(json.dumps(result))',
    'finally:',
    '  if child.poll() is None: child.kill(); child.wait()',
    '  mapped.close(); os.close(source)',
  ].join('\n'))
  const result = cp.spawnSync('python3', ['-I', '-S', '-B', pythonRunner], {
    encoding: 'utf8', timeout: 15000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const record = JSON.parse(result.stdout)
  assert.equal(record.code, 'PREIMAGE_UNSAFE')
  // This assertion establishes that the content recheck, rather than the
  // existing stat comparison, is what closes this real Linux reproduction.
  assert.equal(record.metadataUnchanged, true)
})

for (const route of ['strict-file', 'external-file']) {
  test(`${route} capture rejects dirty mmap bytes changed after its first read`, { skip: !linux }, t => {
    const { root, tree } = fixture(t)
    const file = path.join(tree, 'a')
    const target = path.join(root, 'target')
    fs.mkdirSync(target)
    if (route === 'external-file') {
      for (const args of [['init', '--initial-branch=fixture'], ['config', 'user.name', 'Fixture'],
        ['config', 'user.email', 'fixture@example.invalid'], ['commit', '--allow-empty', '-m', 'fixture']]) {
        const result = cp.spawnSync('git', args, { cwd: target, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
      }
    }
    const nodeRunner = path.join(root, 'file-capture.cjs')
    const pythonRunner = path.join(root, 'file-writer.py')
    fs.writeFileSync(nodeRunner, [
      "const fs = require('node:fs')",
      `const runtime = require(${JSON.stringify(path.join(workflow, 'runtime-state.js'))})`,
      `const core = require(${JSON.stringify(path.join(workflow, 'phase-budget.js'))})`,
      `const file = ${JSON.stringify(file)}, target = ${JSON.stringify(target)}`,
      "const resources = core.candidateExternalLocalResources([{kind:'file',identity:file,owner:'worker-1',ownershipMode:'single-owner'}], target, 'Create the exact file output `' + file + '`.')",
      'const identity = fs.statSync(file); const original = fs.readFileSync; let changed = false',
      'function read(source, ...args) {',
      '  const bytes = original(source, ...args)',
      '  if (!changed && Number.isInteger(source) && fs.fstatSync(source).ino === identity.ino) {',
      "    changed = true; fs.writeSync(1, 'MUTATE\\n')",
      "    if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw Error('writer closed')",
      '  }',
      '  return bytes',
      '}',
      'const observed = Object.create(fs); observed.readFileSync = read',
      route === 'external-file' ? 'fs.readFileSync = read' : '',
      'try {',
      route === 'strict-file' ? '  runtime.readFileStrict(file, observed)' : '  core.hashWorkspaceCandidate(target, process.env, resources)',
      "  fs.writeSync(1, JSON.stringify({accepted:true}) + '\\n')",
      "} catch (error) { fs.writeSync(1, JSON.stringify({code:error.code}) + '\\n') }",
    ].join('\n'))
    fs.writeFileSync(pythonRunner, [
      'import json, mmap, os, subprocess',
      `fd=os.open(${JSON.stringify(file)}, os.O_RDWR)`,
      "mapped=mmap.mmap(fd, 5); mapped[:]=b'old-a'",
      `child=subprocess.Popen([${JSON.stringify(process.execPath)}, ${JSON.stringify(nodeRunner)}], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)`,
      'try:',
      "  assert child.stdout.readline() == 'MUTATE\\n'",
      '  before=os.fstat(fd)',
      "  mapped[:]=b'new-a'",
      '  after=os.fstat(fd)',
      "  child.stdin.write('1'); child.stdin.flush()",
      '  result=json.loads(child.stdout.readline())',
      '  assert child.wait(timeout=10) == 0, child.stderr.read()',
      "  result['metadataUnchanged']=(before.st_mtime_ns,before.st_ctime_ns)==(after.st_mtime_ns,after.st_ctime_ns)",
      '  print(json.dumps(result))',
      'finally:',
      '  if child.poll() is None: child.kill(); child.wait()',
      '  mapped.close(); os.close(fd)',
    ].join('\n'))
    const result = cp.spawnSync('python3', ['-I', '-S', '-B', pythonRunner], { encoding: 'utf8', timeout: 15000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    const record = JSON.parse(result.stdout)
    assert.equal(record.code, 'PREIMAGE_UNSAFE')
    assert.equal(record.metadataUnchanged, true)
  })
}
