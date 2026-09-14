'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { readLineSync } = require('../../bin/autoprompt.cjs')

test('interactive stdin retries transient errors and restores raw mode on fatal errors', t => {
  const modes = [], data = Buffer.from('late 雪\n')
  let call = 0, offset = 0
  t.mock.method(fs, 'readSync', (_fd, buffer) => {
    if (call < 3) throw Object.assign(new Error('transient'), { code: ['EINTR', 'EAGAIN', 'EWOULDBLOCK'][call++] })
    buffer[0] = data[offset++]; return 1
  })
  assert.equal(readLineSync({ fd: 123, isTTY: true, setRawMode: mode => modes.push(mode) }, { write() {} }), 'late 雪')
  assert.deepEqual(modes, [true, false])
  t.mock.method(fs, 'readSync', () => { throw Object.assign(new Error('fatal'), { code: 'EBADF' }) })
  assert.throws(() => readLineSync({ fd: 123, isTTY: true, setRawMode: mode => modes.push(mode) }, { write() {} }), { code: 'EBADF' })
  assert.deepEqual(modes, [true, false, true, false])
})

test('real nonblocking POSIX pipe waits for delayed UTF-8 input without EAGAIN failure', {
  skip: process.platform === 'win32' || cp.spawnSync('python3', ['--version']).status !== 0,
}, () => {
  const script = [
    'import os, subprocess, sys, time',
    'reader, writer = os.pipe()',
    'os.set_blocking(reader, False)',
    'child = subprocess.Popen([sys.argv[1], "-e", "process.stdout.write(require(process.argv[1]).readLineSync(process.stdin, process.stdout))", sys.argv[2]], stdin=reader, stdout=subprocess.PIPE, stderr=subprocess.PIPE)',
    'os.close(reader)',
    'time.sleep(0.1)',
    'os.write(writer, "late 雪\\n".encode("utf-8"))',
    'os.close(writer)',
    'out, err = child.communicate(timeout=5)',
    'sys.stdout.buffer.write(out)',
    'sys.stderr.buffer.write(err)',
    'sys.exit(child.returncode)',
  ].join('\n')
  const result = cp.spawnSync('python3', ['-c', script, process.execPath, path.resolve(__dirname, '../../bin/autoprompt.cjs')],
    { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}`)
  assert.equal(result.stdout, 'late 雪')
})
