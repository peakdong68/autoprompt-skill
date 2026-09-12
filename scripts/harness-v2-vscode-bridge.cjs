#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { HarnessError, readBound } = require('./harness-v2-native.cjs')
async function probeExtensionBridge({ root, signal, timeoutMs = 10000 }) {
  if (!path.isAbsolute(root || '')) throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'An installed, running extension bridge and private root are required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge timeout must be a positive bounded duration')
  const inspect = file => {
    try { return fs.lstatSync(file) } catch (error) { throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge endpoint is unavailable', { code: error.code }) }
  }
  const stat = inspect(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge root is not private and owned')
  const tokenFile = path.join(root, 'token')
  const tokenStat = inspect(tokenFile)
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.nlink !== 1 || tokenStat.mode & 0o077 || process.getuid && tokenStat.uid !== process.getuid()) throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge credential is not private and owned')
  const token = readBound(tokenFile).toString('utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Invalid bridge authentication token')
  const socketFile = path.join(root, 'bridge.sock')
  const socketStat = inspect(socketFile)
  if (!socketStat.isSocket() || socketStat.mode & 0o077 || process.getuid && socketStat.uid !== process.getuid()) throw new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge socket is not private and owned')
  if (signal?.aborted) throw new HarnessError('CHILD_CANCELLED', 'Bridge probe cancelled')
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(); let buffer = ''; let settled = false
    let timer
    const socket = net.createConnection(socketFile)
    const done = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(result)
    }
    const abort = () => done(new HarnessError('CHILD_CANCELLED', 'Bridge probe cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    socket.setEncoding('utf8')
    timer = setTimeout(() => done(new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge capability probe timed out')), timeoutMs)
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, token, method: 'capabilities' })}\n`))
    socket.on('error', error => done(new HarnessError('EXTENSION_HOST_BRIDGE_REQUIRED', 'Bridge connection failed', { code: error.code })))
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 1024 * 1024) { done(new HarnessError('TRANSPORT_LIMIT_EXCEEDED', 'Bridge response exceeds capture limit')); return }
      if (!buffer.includes('\n')) return
      try {
        const result = JSON.parse(buffer.trim())
        if (result.id !== id || result.provider !== 'vscode' || result.protocolVersion !== 1 || result.extensionId !== 'autoprompt.autoprompt-native-bridge') throw new Error('identity mismatch')
        done(null, result)
      } catch { done(new HarnessError('TRANSPORT_INVALID', 'Invalid VS Code bridge response')) }
    })
    socket.on('end', () => { if (!buffer.includes('\n')) done(new HarnessError('TRANSPORT_INVALID', 'VS Code bridge closed without a complete response')) })
  })
}
module.exports = { probeExtensionBridge }
if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv.length !== 2 || argv[0] !== '--probe') { process.stderr.write('usage: harness-v2-vscode-bridge.cjs --probe <private-bridge-root>\n'); process.exitCode = 2 }
  else probeExtensionBridge({ root: argv[1] }).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { process.stdout.write(`${JSON.stringify({ error: { code: error.code || 'EXTENSION_HOST_BRIDGE_REQUIRED', message: error.message } })}\n`); process.exitCode = 2 })
}
