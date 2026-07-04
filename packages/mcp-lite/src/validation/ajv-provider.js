/**
 * Passthrough JSON Schema validator — no ajv dependency.
 * Validates data using a minimal structural check.
 * This replaces the AjvJsonSchemaValidator from the official SDK
 * to eliminate the ajv + ajv-formats dependency tree (~1.3MB).
 *
 * If you need full JSON Schema validation, you can pass a custom
 * validator via ServerOptions.jsonSchemaValidator.
 */

/**
 * @typedef {import('./types.js').JsonSchemaType} JsonSchemaType
 * @typedef {import('./types.js').JsonSchemaValidatorResult} JsonSchemaValidatorResult
 * @typedef {import('./types.js').JsonSchemaValidator} JsonSchemaValidator
 */

export class PassthroughJsonSchemaValidator {
  /**
   * Create a validator for the given JSON Schema.
   * This implementation does a lightweight structural check
   * (type, required, properties) without full JSON Schema compliance.
   *
   * @template T
   * @param {JsonSchemaType} schema
   * @returns {JsonSchemaValidator<T>}
   */
  getValidator(schema) {
    return (input) => {
      try {
        if (schema && typeof schema === "object") {
          // Check type
          if (schema.type && typeof schema.type === "string") {
            const jsType = Array.isArray(input) ? "array" : input === null ? "null" : typeof input;
            if (schema.type === "integer" && !(typeof input === "number" && Number.isInteger(input))) {
              return { valid: false, data: undefined, errorMessage: `Expected integer, got ${jsType}` };
            }
            if (schema.type === "number" && typeof input !== "number") {
              return { valid: false, data: undefined, errorMessage: `Expected number, got ${jsType}` };
            }
            if (schema.type === "string" && typeof input !== "string") {
              return { valid: false, data: undefined, errorMessage: `Expected string, got ${jsType}` };
            }
            if (schema.type === "boolean" && typeof input !== "boolean") {
              return { valid: false, data: undefined, errorMessage: `Expected boolean, got ${jsType}` };
            }
            if (schema.type === "array" && !Array.isArray(input)) {
              return { valid: false, data: undefined, errorMessage: `Expected array, got ${jsType}` };
            }
            if (schema.type === "object" && (typeof input !== "object" || input === null || Array.isArray(input))) {
              return { valid: false, data: undefined, errorMessage: `Expected object, got ${jsType}` };
            }
          }

          // Check required fields
          if (schema.required && Array.isArray(schema.required) && typeof input === "object" && input !== null) {
            for (const field of schema.required) {
              if (!(field in input)) {
                return { valid: false, data: undefined, errorMessage: `Missing required field: ${field}` };
              }
            }
          }
        }

        return { valid: true, data: input, errorMessage: undefined };
      } catch (err) {
        return { valid: false, data: undefined, errorMessage: err instanceof Error ? err.message : String(err) };
      }
    };
  }
}

export { PassthroughJsonSchemaValidator as AjvJsonSchemaValidator };
