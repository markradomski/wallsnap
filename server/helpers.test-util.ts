import type { Gateway, ToolResult } from './gateway'

/** Records every call that reaches the wrapped (transport-level) gateway. */
export class Recorder implements Gateway {
  readonly calls: { tool: string; args: Record<string, unknown> }[] = []
  constructor(private inner: Gateway) {}
  get kind() {
    return this.inner.kind
  }
  call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ tool, args })
    return this.inner.call(tool, args)
  }
  writes() {
    return this.calls.filter((c) => !['list_floors', 'list_entities'].includes(c.tool))
  }
}
