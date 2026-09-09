'use strict'

const { PassThrough } = require('node:stream')
const { StringDecoder } = require('node:string_decoder')
const toolServer = require('../../harness-v2-tool-server.cjs')

class GrokHostMcpError extends Error { constructor(code, message) { super(message); this.name = 'GrokHostMcpError'; this.code = code } }
const fail = (code, message) => { throw new GrokHostMcpError(code, message) }
function createHostMcpRelay(options = {}) {
  if (!options.boundary || typeof options.boundary.policyPath !== 'string' || typeof options.boundary.policySha256 !== 'string') fail('GROK_HOST_MCP_CONFIG_INVALID', 'A sealed tool boundary is required')
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(), decoder = new StringDecoder('utf8')
  let buffer = '', closed = false
  output.on('data', bytes => {
    buffer += decoder.write(bytes)
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      let message; try { message = JSON.parse(line) } catch { continue }
      const item = pending.get(String(message.id)); if (item) { pending.delete(String(message.id)); item.resolve({ line }) }
    }
  })
  const server = toolServer.start({ boundary: options.boundary, input, output })
  return {
    async handle(request) {
      if (closed || !request || typeof request.line !== 'string' || Buffer.byteLength(request.line) > 5 * 1024 * 1024) fail('GROK_HOST_MCP_INVALID', 'MCP relay request is invalid')
      let message; try { message = JSON.parse(request.line) } catch { fail('GROK_HOST_MCP_INVALID', 'MCP relay request is invalid JSON') }
      if (!Object.hasOwn(message, 'id')) { input.write(`${request.line}\n`); return { line: '' } }
      const key = String(message.id); if (pending.has(key)) fail('GROK_HOST_MCP_INVALID', 'MCP request id is already pending')
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(key); reject(new GrokHostMcpError('GROK_HOST_MCP_TIMEOUT', 'MCP relay request timed out')) }, 300000); timer.unref?.()
        pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value) }, reject })
        input.write(`${request.line}\n`)
      })
    },
    async close() { closed = true; for (const item of pending.values()) item.reject(new GrokHostMcpError('GROK_HOST_MCP_CLOSED', 'MCP relay closed')); pending.clear(); input.end(); await server.close() },
  }
}
module.exports = { GrokHostMcpError, createHostMcpRelay }
