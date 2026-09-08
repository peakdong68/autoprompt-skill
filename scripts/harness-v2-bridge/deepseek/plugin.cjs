'use strict'

// Loaded only by the controller's isolated sdk-minimal overlay. The official
// SDK owns the agent loop and durable history; this plugin supplies the missing
// resume operation and replaces unrestricted built-ins with fixed owned tools.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const boundary = require('../../harness-v2-tool-boundary.cjs')
const { openController, NAMES } = require('../pi/controller.cjs')

exports.name = 'autoprompt-deepseek-owned-sdk'
exports.inject = ['agents', 'tools']
exports.apply = async function apply(ctx, config) {
  if (!path.isAbsolute(config.packageRoot || '')) throw new Error('An exact official SDK package root is required')
  const load = name => import(pathToFileURL(path.join(config.packageRoot, name, 'lib/index.js')).href)
  const [{ HarnessSdkJsonRpcServer }, { JsonRpcLineTransport }] = await Promise.all([
    load('dsh-sdk-jsonrpc-server'), load('dsh-sdk-protocol'),
  ])
  const controller = openController('deepseek')
  for (const tool of boundary.TOOLS) {
    const name = `autoprompt_owned_${tool.name}`
    ctx.tools.register({ name, description: tool.description, parameters: tool.inputSchema,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, execution) => (await controller.execute(name, args, execution.signal)).details.actualResult,
    })
  }
  class OwnedServer extends HarnessSdkJsonRpcServer {
    async initialize(params) {
      if (params.resumeSessionId !== undefined && !/^[A-Za-z0-9_.:-]{1,256}$/.test(params.resumeSessionId)) throw new Error('Invalid bound native resume identity')
      this.resumeSessionId = params.resumeSessionId
      return super.initialize(params)
    }
    async createSession(sessionId) {
      if (this.resumeSessionId && sessionId !== this.resumeSessionId) throw new Error('Native session differs from the bound continuation')
      const agentOptions = { provider: this.provider, model: this.model,
        ...(this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort }),
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }) }
      const setup = agentCtx => { agentCtx.tools.restrict({ allow: [...NAMES] }) }
      const handle = this.resumeSessionId
        ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await this.ctx.agents.create({ sessionId, meta: { cwd: this.cwd }, agentOptions, setup })
      const record = { handle }; this.sessions.set(sessionId, record); return record
    }
  }
  if (config.oneShot) {
    let server, ending = false, ended = false
    const transport = { notify(method, params) {
      process.stdout.write(`${JSON.stringify({ type: 'deepseek', method, params })}\n`)
      if (method === 'session.event' && params.event.type === 'turn/end') ended = true
      if (method === 'session.status' && params.status === 'idle' && ended && !ending) {
        ending = true
        setImmediate(async () => {
          try { await ctx.root.fiber.dispose(); process.exitCode = 0 }
          catch { process.exitCode = 1 }
        })
      }
    } }
    server = new OwnedServer(ctx, transport, { maxTokensAsSuccess: false })
    ctx.effect(() => async () => { try { await server.shutdown() } finally { await controller.close() } }, 'autoprompt.ownedSdk')
    setImmediate(async () => {
      try {
        await ctx.get('loader')?.await()
        await server.initialize(config.initialize)
        await server.prompt({ sessionId: config.sessionId, contentBlocks: [{ type: 'text', text: config.input }] })
      } catch (error) {
        process.stderr.write(`DEEPSEEK_OWNED_FAILURE: ${error.message}\n`)
        try { await ctx.root.fiber.dispose() } finally { process.exitCode = 1 }
      }
    })
    return
  }
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  const server = new OwnedServer(ctx, transport, { maxTokensAsSuccess: false })
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await()
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') setImmediate(async () => {
      try { await transport.flush(); await ctx.root.fiber.dispose(); process.exit(0) }
      catch { process.exit(1) }
    })
    return result
  })
  ctx.effect(() => {
    transport.start()
    return async () => { try { await server.shutdown() } finally { await controller.close(); transport.close() } }
  }, 'autoprompt.ownedSdk')
}
