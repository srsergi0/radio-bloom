declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  export class McpServer {
    constructor(options: { name: string; version: string });
    tool(name: string, description: string, schema: any, handler: (...args: any[]) => any): void;
    connect(transport: any): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  export class StdioServerTransport {
    constructor();
  }
}

declare module "../node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js" {
  export interface WebStandardStreamableHTTPServerTransportOptions {
    sessionIdGenerator?: () => string;
    enableJsonResponse?: boolean;
    onsessioninitialized?: (sessionId: string) => void;
    onsessionclosed?: (sessionId: string) => void;
  }

  export interface HandleRequestOptions {}

  export class WebStandardStreamableHTTPServerTransport {
    constructor(options: WebStandardStreamableHTTPServerTransportOptions);
    handleRequest(req: Request): Promise<Response>;
    close(): Promise<void>;
  }

  export type WebStandardStreamableHTTPServerTransportType =
    WebStandardStreamableHTTPServerTransport;
}
