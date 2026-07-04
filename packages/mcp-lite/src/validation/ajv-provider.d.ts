// validation/ajv-provider.d.ts — Passthrough JSON Schema validator types
// Matches src/validation/ajv-provider.js

import type { JsonSchemaType, JsonSchemaValidator } from "./types.js";

/**
 * Passthrough JSON Schema validator — no ajv dependency.
 * Validates data using a minimal structural check.
 * This replaces the AjvJsonSchemaValidator from the official SDK.
 */
export declare class PassthroughJsonSchemaValidator {
  /**
   * Create a validator for the given JSON Schema.
   * This implementation does a lightweight structural check
   * (type, required, properties) without full JSON Schema compliance.
   */
  getValidator<T = unknown>(schema: JsonSchemaType): JsonSchemaValidator<T>;
}

/** @deprecated Use PassthroughJsonSchemaValidator instead */
export { PassthroughJsonSchemaValidator as AjvJsonSchemaValidator };
