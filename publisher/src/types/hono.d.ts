declare module "hono" {
  interface Context {
    req: {
      json(): Promise<any>;
      formData(): Promise<FormData>;
      param(name: string): string;
      query(name: string): string | undefined;
      raw: Request;
    };
    json(data: any, status?: number): Response;
    newResponse(
      body: any,
      init?: { status?: number; statusText?: string; headers?: any }
    ): Response;
  }

  type H = (c: Context) => Response | Promise<Response>;

  class Hono {
    get(path: string, ...handlers: H[]): this;
    post(path: string, ...handlers: H[]): this;
    put(path: string, ...handlers: H[]): this;
    delete(path: string, ...handlers: H[]): this;
    all(path: string, ...handlers: H[]): this;
    use(path: string, middleware: any): this;
    use(middleware: any): this;
    fetch(req: Request): Response | Promise<Response>;
  }

  export { Context, Hono };
}

declare module "hono/bun" {
  export function serveStatic(options: {
    root: string;
    rewriteRequestPath?: (path: string) => string;
  }): any;
}

declare module "hono/cors" {
  export function cors(options?: { exposeHeaders?: string[] }): any;
}
