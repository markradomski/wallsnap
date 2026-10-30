// Stand-in for the FloorGen MCP client in the static demo, which never connects to FloorGen.
export class Client {
  constructor() {
    throw new Error('Demo Mode has no FloorGen connection.')
  }
}
export class StreamableHTTPClientTransport {}
