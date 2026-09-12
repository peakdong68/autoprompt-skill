'use strict'

const net = require('node:net')
const { StringDecoder } = require('node:string_decoder')

class GrokMcpRelayError extends Error { constructor(code, message) { super(message); this.name = 'GrokMcpRelayError'; this.code = code } }
const fail = (code, message) => { throw new GrokMcpRelayError(code, message) }

function createMcpLoopbackServer(options = {}) {
  const port = options.port
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || typeof options.forward !== 'function') fail('GROK_MCP_RELAY_CONFIG_INVALID', 'MCP loopback configuration is invalid')
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    const decoder = new StringDecoder('utf8'); let buffer = '', chain = Promise.resolve()
    socket.on('data', bytes => {
      buffer += decoder.write(bytes)
      if (Buffer.byteLength(buffer) > 5 * 1024 * 1024) return socket.destroy()
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line) continue
        chain = chain.then(async () => {
          const result = await options.forward(line)
          if (!result || typeof result.line !== 'string' || Buffer.byteLength(result.line) > 5 * 1024 * 1024) fail('GROK_MCP_RELAY_INVALID', 'Host MCP response is invalid')
          socket.write(`${result.line}\n`)
        }).catch(() => socket.destroy())
      }
    })
  })
  return {
    server,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) }) },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
function parsePort(argv) {
  if (argv.length !== 2 || argv[0] !== '--port' || !/^\d+$/u.test(argv[1])) fail('GROK_MCP_RELAY_CONFIG_INVALID', 'Use --port <loopback-port>')
  return Number(argv[1])
}
if (require.main === module) {
  const port = parsePort(process.argv.slice(2))
  const socket = net.createConnection(port, '127.0.0.1')
  socket.pipe(process.stdout); process.stdin.pipe(socket)
  socket.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
module.exports = { GrokMcpRelayError, createMcpLoopbackServer, parsePort }
