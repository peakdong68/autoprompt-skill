'use strict'

// Uses only the public VS Code extension-host API. Stable LanguageModelChat
// responses currently expose streams, not billed usage or native chat session
// identities. countTokens is an estimate surface, not an accounting receipt.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const EXTENSION_ID = 'autoprompt.autoprompt-native-bridge'
async function capabilities(vscode) {
  const models = typeof vscode.lm?.selectChatModels === 'function' ? await vscode.lm.selectChatModels({}) : []
  return {
    protocolVersion: 1, provider: 'vscode', extensionId: EXTENSION_ID,
    extensionHostVersion: vscode.version,
    languageModelApi: typeof vscode.lm?.selectChatModels === 'function',
    models: models.map(model => ({ id: model.id, vendor: model.vendor, family: model.family, version: model.version })),
    exactUsage: false, nativeSessionContinuation: false, conformance: 'NOT_SUPPORTED',
    blockers: ['PROVIDER_BILLED_USAGE_UNAVAILABLE', 'NATIVE_CHAT_SESSION_API_UNAVAILABLE'],
  }
}
async function activate(context) {
  const vscode = require('vscode')
  context.subscriptions.push(vscode.commands.registerCommand('autoprompt.native.capabilities', () => capabilities(vscode)))
  if (process.env.AUTOPROMPT_VSCODE_OWNED_REQUEST) return require('./owned-session.cjs').activateOwned(context, vscode)
  const root = process.env.AUTOPROMPT_VSCODE_BRIDGE_ROOT
  if (!root) return
  return startBridge(context, vscode, root)
}
async function startBridge(context, vscode, root) {
  if (process.platform === 'win32') throw new Error('Autoprompt native bridge requires an authenticated Windows named-pipe boundary; none is installed')
  const stat = fs.lstatSync(root)
  if (!path.isAbsolute(root) || !stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error('Autoprompt native bridge requires an owned private directory')
  const tokenPath = path.join(root, 'token')
  const tokenStat = fs.lstatSync(tokenPath)
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.nlink !== 1 || tokenStat.mode & 0o077 || tokenStat.uid !== process.getuid()) throw new Error('Autoprompt bridge token is not private')
  const token = fs.readFileSync(tokenPath, { flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }).toString('utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Autoprompt bridge token is invalid')
  const socketPath = path.join(root, 'bridge.sock')
  if (fs.existsSync(socketPath)) throw new Error('Autoprompt bridge endpoint already exists')
  const connections = new Set()
  const server = net.createServer(socket => {
    connections.add(socket); socket.setTimeout(10000, () => socket.destroy()); socket.setEncoding('utf8')
    let buffer = ''; let handled = false
    socket.on('close', () => connections.delete(socket)); socket.on('error', () => {})
    socket.on('data', async chunk => {
      if (handled) { socket.destroy(); return }
      buffer += chunk
      if (Buffer.byteLength(buffer) > 65536) { socket.destroy(); return }
      if (!buffer.includes('\n')) return
      handled = true
      try {
        const request = JSON.parse(buffer.trim())
        if (typeof request.token !== 'string' || request.token.length !== token.length || !crypto.timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) throw new Error('Bridge authentication failed')
        const result = request.method === 'capabilities' ? await capabilities(vscode) : {
          error: { code: 'PROVIDER_UNSUPPORTED', message: 'Stable VS Code LM API does not expose exact billed usage or native chat session continuation; execution was not started' },
        }
        socket.end(`${JSON.stringify({ id: request.id, ...result })}\n`)
      } catch { socket.end(`${JSON.stringify({ error: { code: 'BRIDGE_REQUEST_INVALID' } })}\n`) }
    })
  })
  let ownedSocket
  let disposed = false
  const disposable = { dispose() {
    if (disposed) return
    disposed = true
    for (const socket of connections) socket.destroy()
    server.close()
    try {
      const current = fs.lstatSync(socketPath)
      if (ownedSocket && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) fs.unlinkSync(socketPath)
    } catch {}
  } }
  context.subscriptions.push(disposable)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600)
        ownedSocket = fs.lstatSync(socketPath)
        resolve()
      } catch (error) { disposable.dispose(); reject(error) }
    })
  })
  return disposable
}
module.exports = { activate, capabilities, startBridge, EXTENSION_ID }
