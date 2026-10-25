import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isRec, rev } from './boundary'

/** A successful FloorGen tool result. `data` is untrusted until parsed by the caller. */
export interface ToolResult {
  rev: number
  data: unknown
}

export interface Gateway {
  readonly kind: 'floorgen' | 'mock'
  call(tool: string, args: Record<string, unknown>): Promise<ToolResult>
}

export class GatewayError extends Error {
  constructor(message: string, readonly tool: string, readonly code?: string) {
    super(message)
  }
}

/** FloorGen failure reply: { ok: false, code, message, hint?, details?, warnings? }. */
export function describeFailure(body: Record<string, unknown>): { text: string; code?: string } {
  const nested = isRec(body.error) ? body.error : body
  const pick = (k: string) => (typeof nested[k] === 'string' ? (nested[k] as string) : typeof body[k] === 'string' ? (body[k] as string) : undefined)
  const message = pick('message') ?? (typeof body.error === 'string' ? body.error : undefined) ?? pick('summary') ?? 'no message from FloorGen'
  const hint = pick('hint')
  const warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : []
  const text = [message, hint && `Hint: ${hint}`, ...warnings.map((w) => `Warning: ${w}`)].filter(Boolean).join(' ')
  return { text, code: pick('code') }
}

/** Validates a raw FloorGen result envelope: { ok: true, rev, data } (anything else is an error). */
export function toResult(tool: string, body: unknown): ToolResult {
  if (!isRec(body)) throw new GatewayError('unreadable response', tool)
  if (body.ok !== true) {
    const f = describeFailure(body)
    throw new GatewayError(f.text, tool, f.code)
  }
  try {
    return { rev: rev(body.rev), data: body.data }
  } catch (e) {
    throw new GatewayError((e as Error).message, tool)
  }
}

/** Real FloorGen MCP connection (Streamable HTTP, bearer API key). The key never leaves the server. */
export class FloorGenGateway implements Gateway {
  readonly kind = 'floorgen' as const
  private client: Promise<Client> | null = null

  constructor(private url: string, private apiKey: string) {}

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: 'wallsnap', version: '0.1.0' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: { headers: { Authorization: `Bearer ${this.apiKey}` } },
        }),
      )
      return client
    })().catch((e: unknown) => {
      this.client = null
      throw e
    })
    return this.client
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    let client: Client
    try {
      client = await this.connect()
    } catch (e) {
      throw new GatewayError(`cannot connect to FloorGen MCP (${(e as Error).message})`, tool)
    }
    const res: unknown = await client.callTool({ name: tool, arguments: args })
    if (!isRec(res)) throw new GatewayError('unreadable response', tool)
    let body: unknown = res.structuredContent
    if (body === undefined && Array.isArray(res.content)) {
      const first: unknown = res.content.find((c: unknown) => isRec(c) && c.type === 'text')
      if (isRec(first) && typeof first.text === 'string') {
        try {
          body = JSON.parse(first.text)
        } catch {
          throw new GatewayError(first.text.slice(0, 200), tool)
        }
      }
    }
    return toResult(tool, body)
  }
}
