declare module "drizzle-orm" {
  export function eq(left: any, right: any): any;
  export function like(left: any, right: any): any;
  export function or(...conditions: any[]): any;
  export function and(...conditions: any[]): any;
  export function desc(column: any): any;
  export function sql<T = any>(strings: TemplateStringsArray, ...values: any[]): T;
  export namespace sql {
    function raw(value: string): any;
  }

  class DrizzleSelect {
    from(table: any): DrizzleSelect;
    where(condition: any): DrizzleSelect;
    orderBy(...columns: any[]): DrizzleSelect;
    limit(n: number): DrizzleSelect;
    offset(n: number): DrizzleSelect;
    $dynamic(): DrizzleSelect;
    get(): any;
    all(): any[];
    then(onfulfilled?: ((value: any[]) => any) | null): Promise<any>;
  }

  export interface DrizzleDb {
    select(...columns: any[]): DrizzleSelect;
    insert(table: any): {
      values(data: any): { run(): any; onConflictDoUpdate(config: any): { run(): any } };
    };
    update(table: any): { set(data: any): { run(): any; where(condition: any): { run(): any } } };
    delete(table: any): { run(): any; where(condition: any): { run(): any } };
    transaction<T>(fn: (tx: DrizzleDb) => T): T;
    $dynamic(): DrizzleSelect;
  }
}

declare module "drizzle-orm/sqlite-core" {
  export function text(name: string): any;
  export function integer(name: string): any;
  export function real(name: string): any;
  export function sqliteTable(name: string, columns: Record<string, any>): any;
}

declare module "drizzle-orm/bun-sqlite" {
  import type { DrizzleDb } from "drizzle-orm";
  export function drizzle(options: { client: any; schema?: any }): DrizzleDb;
}
