// Lazy-loaded Zod schema (sync preload via global cache)
let _JSONRPCMessageSchema;
export function deserializeMessage(line) {
    if (!_JSONRPCMessageSchema) {
        // Synchronous require for stdio (Bun/Node support it)
        _JSONRPCMessageSchema = require('../types.js').JSONRPCMessageSchema;
    }
    return _JSONRPCMessageSchema.parse(JSON.parse(line));
}
/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    append(chunk) {
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }
    readMessage() {
        if (!this._buffer) {
            return null;
        }
        const index = this._buffer.indexOf('\n');
        if (index === -1) {
            return null;
        }
        const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
    }
    clear() {
        this._buffer = undefined;
    }
}
export function serializeMessage(message) {
    return JSON.stringify(message) + '\n';
}
//# sourceMappingURL=stdio.js.map