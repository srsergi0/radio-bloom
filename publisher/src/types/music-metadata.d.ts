declare module "music-metadata" {
  interface Metadata {
    format: { duration?: number };
    common: { artist?: string; album?: string; title?: string };
    native: Record<string, Array<{ id?: string; value?: any }>>;
  }
  export function parseFile(filePath: string): Promise<Metadata>;
}
