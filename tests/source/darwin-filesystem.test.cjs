'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const runtime = require('../../agents/codex/workflow/runtime-state.js')
const helper = path.resolve(__dirname, '../../agents/codex/workflow/darwin-filesystem.py')
const posix = ['linux', 'darwin'].includes(process.platform)

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-dirfd-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tree = path.join(root, 'tree')
  fs.mkdirSync(tree, { mode: 0o700 })
  return { root, tree }
}

function capture(root, target, options = {}) {
  const spoolPath = options.spoolPath || path.join(root, `capture-${crypto.randomUUID()}`)
  const descriptor = fs.openSync(spoolPath, 'wx+', options.mode ?? 0o600)
  try {
    const result = cp.spawnSync('python3', ['-I', '-S', '-B', options.runner || helper, '--request'], {
      stdio: ['pipe', 'pipe', 'pipe', descriptor], encoding: 'utf8', timeout: 15000,
      maxBuffer: 9 * 1024 * 1024,
      input: options.input || JSON.stringify({ schemaVersion: 1, operation: options.operation || 'capture-tree', path: target }),
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    return { record: JSON.parse(result.stdout), bytes: fs.readFileSync(spoolPath) }
  } finally { fs.closeSync(descriptor) }
}

function digest(captured) {
  const hash = crypto.createHash('sha256')
  const entries = captured.record.entries
  const visit = relative => {
    const children = entries.filter(entry => entry.path !== '' &&
      path.posix.dirname(entry.path) === (relative || '.'))
      .sort((a, b) => path.posix.basename(a.path).localeCompare(path.posix.basename(b.path)))
    for (const entry of children) {
      const mode = entry.stat.mode & 0o777
      if (entry.type === 'directory') {
        hash.update(`directory\0${entry.path}\0${mode}\0`)
        visit(entry.path)
      } else {
        hash.update(`file\0${entry.path}\0${mode}\0${entry.length}\0`)
        hash.update(captured.bytes.subarray(entry.offset, entry.offset + entry.length))
        hash.update('\0')
      }
    }
  }
  visit('')
  return hash.digest('hex')
}

test('descriptor capture preserves exact bytes, mode framing and Node Unicode name order', { skip: !posix }, t => {
  const { root, tree } = fixture(t)
  for (const [name, bytes] of [['z.txt', Buffer.from([0, 255, 10])], ['A.txt', 'upper'], ['a.txt', 'lower'], ['é.txt', 'accent']]) {
    // Case-insensitive APFS cannot hold distinct A/a entries; Linux parity
    // covers that pair, while native APFS still covers Unicode and binary IO.
    const file = path.join(tree, name)
    if (fs.existsSync(file)) continue
    fs.writeFileSync(file, bytes, { mode: 0o640 })
  }
  fs.mkdirSync(path.join(tree, 'nested'), { mode: 0o750 })
  fs.writeFileSync(path.join(tree, 'nested', 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 17, 0xad), { mode: 0o600 })
  fs.mkdirSync(path.join(tree, 'empty'), { mode: 0o700 })
  const result = capture(root, tree)
  assert.equal(result.record.status, 'CAPTURED')
  assert.equal(result.record.bytes, result.bytes.length)
  assert.ok(result.record.entries.every(entry => !Object.hasOwn(entry, 'content')))
  if (process.platform === 'linux') assert.equal(digest(result), runtime.hashDirectoryStateStrict(tree))
  const large = result.record.entries.find(entry => entry.path === 'nested/large.bin')
  assert.deepEqual(result.bytes.subarray(large.offset, large.offset + large.length), fs.readFileSync(path.join(tree, large.path)))
})

test('descriptor capture rejects linked leaves, hardlinks, linked ancestors and non-file leaves', { skip: !posix }, t => {
  const { root, tree } = fixture(t)
  const file = path.join(tree, 'file')
  fs.writeFileSync(file, 'bound')
  fs.symlinkSync(tree, path.join(root, 'alias'))
  assert.equal(capture(root, path.join(root, 'alias')).record.code, 'PREIMAGE_UNSAFE')
  assert.equal(capture(root, path.join(root, 'alias', 'file'), { operation: 'capture-file' }).record.code, 'PREIMAGE_UNSAFE')
  fs.linkSync(file, path.join(tree, 'hardlink'))
  assert.equal(capture(root, tree).record.code, 'PREIMAGE_UNSAFE')
  assert.equal(capture(root, file, { operation: 'capture-file' }).record.code, 'PREIMAGE_UNSAFE')
  assert.equal(capture(root, tree, { operation: 'capture-file' }).record.code, 'PREIMAGE_UNSAFE')
})

test('capture spool must be private, cannot be part of the captured tree, and carries no accepted partial result', { skip: !posix }, t => {
  const { root, tree } = fixture(t)
  fs.writeFileSync(path.join(tree, 'file'), 'payload')
  assert.equal(capture(root, tree, { spoolPath: path.join(tree, 'spool') }).record.status, 'REFUSED')
  const previous = process.umask(0)
  try {
    assert.equal(capture(root, tree, { mode: 0o644 }).record.code, 'FILESYSTEM_SPOOL_INVALID')
  } finally { process.umask(previous) }
})

test('capture request rejects duplicate keys, unknown fields, noncanonical paths and invented operations', { skip: !posix }, t => {
  const { root, tree } = fixture(t)
  const request = { schemaVersion: 1, operation: 'capture-tree', path: tree }
  for (const input of [
    JSON.stringify({ ...request, executable: '/bin/sh' }),
    JSON.stringify({ ...request, operation: 'remove-tree' }),
    JSON.stringify({ ...request, path: tree + '/.' }),
    JSON.stringify({ ...request, schemaVersion: true }),
    JSON.stringify(request).replace('{', '{"schemaVersion":1,'),
  ]) assert.deepEqual(capture(root, tree, { input }).record,
    { schemaVersion: 1, status: 'REFUSED', code: 'FILESYSTEM_REQUEST_INVALID' })
})

test('a later-file read cannot hide a change to an already captured file', { skip: !posix }, t => {
  const { root, tree } = fixture(t)
  fs.writeFileSync(path.join(tree, 'a'), 'old-a')
  fs.writeFileSync(path.join(tree, 'b'), 'old-b')
  const runner = path.join(root, 'race.py')
  fs.writeFileSync(runner, [
    'import importlib.util, os',
    `spec=importlib.util.spec_from_file_location('capture', ${JSON.stringify(helper)})`,
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'original_stat=os.stat; original_listdir=os.listdir; switched=False',
    'def raced_stat(name, *args, **kwargs):',
    '  global switched',
    "  if name == 'b' and not switched:",
    '    switched=True',
    `    with open(${JSON.stringify(path.join(tree, 'a'))}, 'wb') as target: target.write(b'new-a')`,
    `    with open(${JSON.stringify(path.join(tree, 'b'))}, 'wb') as target: target.write(b'new-b')`,
    '  return original_stat(name, *args, **kwargs)',
    'os.stat=raced_stat; os.listdir=lambda fd: sorted(original_listdir(fd))',
    'os.supports_dir_fd.add(os.stat); os.supports_follow_symlinks.add(os.stat); os.supports_fd.add(os.listdir)',
    'module.main()',
  ].join('\n'))
  const result = capture(root, tree, { runner })
  assert.deepEqual(result.record, { schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.readFileSync(path.join(tree, 'a'), 'utf8'), 'new-a')
  assert.equal(fs.readFileSync(path.join(tree, 'b'), 'utf8'), 'new-b')
})

test('capture rechecks bytes changed through an already-dirty writable mmap', { skip: !posix }, t => {
  const { root, tree } = fixture(t)
  fs.writeFileSync(path.join(tree, 'a'), 'old-a')
  fs.writeFileSync(path.join(tree, 'b'), 'old-b')
  const runner = path.join(root, 'mmap-race.py')
  fs.writeFileSync(runner, [
    'import importlib.util, os, mmap',
    `spec=importlib.util.spec_from_file_location('capture', ${JSON.stringify(helper)})`,
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    `source=os.open(${JSON.stringify(path.join(tree, 'a'))}, os.O_RDWR)`,
    "mapped=mmap.mmap(source, 5); mapped[:]=b'old-a'",
    'original_listdir=os.listdir',
    'os.listdir=lambda fd: sorted(original_listdir(fd)); os.supports_fd.add(os.listdir)',
    'class StagedCapture(module.Capture):',
    '  def file(self, parent, name, relative, before):',
    '    super().file(parent, name, relative, before)',
    "    if relative == 'a':",
    "      mapped[:]=b'new-a'",
    `      with open(${JSON.stringify(path.join(tree, 'b'))}, 'wb') as target: target.write(b'new-b')`,
    'module.Capture=StagedCapture',
    'try: module.main()',
    'finally: mapped.close(); os.close(source)',
  ].join('\n'))
  const result = capture(root, tree, { runner })
  assert.deepEqual(result.record, { schemaVersion: 1, status: 'REFUSED', code: 'PREIMAGE_UNSAFE' })
  assert.equal(fs.readFileSync(path.join(tree, 'a'), 'utf8'), 'new-a')
  assert.equal(fs.readFileSync(path.join(tree, 'b'), 'utf8'), 'new-b')
})
