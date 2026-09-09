'use strict'

// Loaded only by the controller's isolated sdk-minimal overlay. The official
// SDK owns the agent loop and durable history; this plugin supplies the missing
// resume operation and replaces unrestricted built-ins with fixed owned tools.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const boundary = require('../../harness-v2-tool-boundary.cjs')
const { openController } = require('../pi/controller.cjs')

const STRUCTURED_OUTPUT_TOOL = 'autoprompt_structured_output'
const STRUCTURED_OUTPUT_ACK = Object.freeze({ recorded: true })

exports.name = 'autoprompt-deepseek-owned-sdk'
exports.inject = ['agents', 'tools']
exports.apply = async function apply(ctx, config) {
  if (!path.isAbsolute(config.packageRoot || '')) throw new Error('An exact official SDK package root is required')
  if (config.oneShot !== true) throw new Error('The owned DeepSeek structured-output bridge is one-shot only')
  const load = name => import(pathToFileURL(path.join(config.packageRoot, name, 'lib/index.js')).href)
  const [{ HarnessSdkJsonRpcServer }, { JsonRpcLineTransport }] = await Promise.all([
    load('dsh-sdk-jsonrpc-server'), load('dsh-sdk-protocol'),
  ])
  const controller = openController('deepseek')
  const allowedTools = controller.state.policy.toolFree === true ? [] : boundary.TOOLS
  const allowedNames = allowedTools.map(tool => `autoprompt_owned_${tool.name}`)
  if (!config.initialize.outputSchema || config.initialize.outputSchema.type !== 'object') throw new Error('DeepSeek requires an object-rooted structured-output schema')
  let structuredRecorded = false
  for (const tool of allowedTools) {
    const name = `autoprompt_owned_${tool.name}`
    ctx.tools.register({ name, description: tool.description, parameters: tool.inputSchema,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, execution) => (await controller.execute(name, args, execution.signal)).details.actualResult,
    })
  }
  ctx.tools.register({
    name: STRUCTURED_OUTPUT_TOOL,
    description: 'Report the final controller result. Call this exactly once when the assignment is complete; the arguments must match this tool schema.',
    parameters: config.initialize.outputSchema,
    output: {
      schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'], additionalProperties: false },
      render: () => [{ type: 'text', text: JSON.stringify(STRUCTURED_OUTPUT_ACK) }],
    },
    execute: async (_args, execution) => {
      if (structuredRecorded) throw new Error('Structured output was already recorded')
      structuredRecorded = true
      execution.concludeTurn()
      return STRUCTURED_OUTPUT_ACK
    },
  })
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
      const setup = agentCtx => {
        agentCtx.systemPrompt.section({
          name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
          order: agentCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
          text: `When the assignment is complete, call ${STRUCTURED_OUTPUT_TOOL} exactly once with the final result. A plain text final answer is invalid.`,
        })
        agentCtx.tools.guard(execution => structuredRecorded ? `structured output already recorded: ${execution.name} is not executed` : undefined)
        agentCtx.tools.restrict({ allow: [...allowedNames, STRUCTURED_OUTPUT_TOOL] })
      }
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
