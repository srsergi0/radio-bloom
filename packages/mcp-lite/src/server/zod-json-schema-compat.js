// zod-json-schema-compat.ts
// ----------------------------------------------------
// JSON Schema conversion for both Zod v3 and Zod v4 (Mini)
// v3 uses your vendored converter; v4 uses Mini's toJSONSchema
// ----------------------------------------------------
// Lazy-loaded: zod/v4-mini only imported when a v4 schema is actually encountered
let _z4mini;
async function loadZ4Mini() {
    if (!_z4mini) {
        _z4mini = await import('zod/v4-mini');
    }
    return _z4mini;
}
// Synchronous cache for when zod/v4-mini is already loaded (e.g., types.js loaded it)
function getZ4MiniSync() {
    return _z4mini;
}
import { getObjectShape, safeParse, isZ4Schema, getLiteralValue } from './zod-compat.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
function mapMiniTarget(t) {
    if (!t)
        return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7')
        return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12')
        return 'draft-2020-12';
    return 'draft-7'; // fallback
}
export function toJsonSchemaCompat(schema, opts) {
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema
        const z4mini = getZ4MiniSync();
        if (!z4mini) {
            throw new Error('zod/v4-mini not loaded. Import zod/v4 or call loadZ4Mini() first.');
        }
        return z4mini.toJSONSchema(schema, {
            target: mapMiniTarget(opts?.target),
            io: opts?.pipeStrategy ?? 'input'
        });
    }
    // v3 branch — use vendored converter
    return zodToJsonSchema(schema, {
        strictUnions: opts?.strictUnions ?? true,
        pipeStrategy: opts?.pipeStrategy ?? 'input'
    });
}
export function getMethodLiteral(schema) {
    const shape = getObjectShape(schema);
    const methodSchema = shape?.method;
    if (!methodSchema) {
        throw new Error('Schema is missing a method literal');
    }
    const value = getLiteralValue(methodSchema);
    if (typeof value !== 'string') {
        throw new Error('Schema method literal must be a string');
    }
    return value;
}
export function parseWithCompat(schema, data) {
    const result = safeParse(schema, data);
    if (!result.success) {
        throw result.error;
    }
    return result.data;
}
// Pre-load zod/v4-mini if types.js has already loaded zod/v4 (they share the same module)
// This is a fire-and-forget optimization
loadZ4Mini().catch(() => {});
//# sourceMappingURL=zod-json-schema-compat.js.map