declare module "zod" {
  const z: {
    string(): any;
    number(): any;
    boolean(): any;
    array(item: any): any;
    object(shape: Record<string, any>): any;
    enum(values: readonly string[]): any;
    literal(value: any): any;
    union(types: any[]): any;
    optional(type: any): any;
    nullable(type: any): any;
    default(type: any, value: any): any;
    coerce: {
      string(): any;
      number(): any;
      boolean(): any;
    };
  };

  export { z };
  export default z;
}
