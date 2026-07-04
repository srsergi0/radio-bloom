export type JsonSchemaType = Record<string, unknown>;
export type JsonSchemaValidatorResult<T> = {
    valid: true;
    data: T;
    errorMessage: undefined;
} | {
    valid: false;
    data: undefined;
    errorMessage: string;
};
export type JsonSchemaValidator<T> = (input: unknown) => JsonSchemaValidatorResult<T>;
export interface jsonSchemaValidator {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
export declare class PassthroughJsonSchemaValidator implements jsonSchemaValidator {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}
export { PassthroughJsonSchemaValidator as AjvJsonSchemaValidator };
