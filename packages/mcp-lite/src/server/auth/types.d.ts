// auth/types.d.ts — Authentication info type
// This is a stub since OAuth was stripped from the package.
// AuthInfo represents authentication data from middleware.

/**
 * Authentication information passed with requests.
 * This is a generic type since OAuth middleware was removed.
 * Custom auth middleware can populate this with any structure.
 */
export type AuthInfo = {
  [key: string]: unknown;
};
