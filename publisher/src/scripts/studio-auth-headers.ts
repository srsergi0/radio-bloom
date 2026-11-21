/**
 * Headers for scripts that call the protected control API.
 * Sends `Authorization: Bearer $STUDIO_TOKEN` when the env var is set.
 */
export function studioHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.STUDIO_TOKEN?.trim();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}
