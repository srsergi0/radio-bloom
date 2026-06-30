declare module "zod" {
  interface ZodType {
    optional(): ZodType;
    default(value: any): ZodType;
    describe(description: string): ZodType;
    min(n: number): ZodType;
    max(n: number): ZodType;
    int(): ZodType;
  }

  const z: {
    string(): ZodType;
    number(): ZodType;
    boolean(): ZodType;
    array(item: ZodType): ZodType;
    object(shape: Record<string, ZodType>): ZodType;
    enum(values: readonly string[]): ZodType;
  };

  export { ZodType, z };
  export default z;
}
