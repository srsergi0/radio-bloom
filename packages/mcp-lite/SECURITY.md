# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in mcp-lite, please report it responsibly.

**DO NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

1. Email: [your-email@example.com] (replace with your actual email)
2. Or use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/srsergi0/mcp-lite/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix or mitigation**: Within 30 days (depending on severity)

## Security Best Practices

When using mcp-lite in production:

1. **Always use HTTPS** for HTTP transport
2. **Validate inputs** — use Zod schemas for all tool parameters
3. **Implement authentication** — use Hono middleware for auth
4. **Rate limit** — protect against abuse
5. **Monitor logs** — watch for suspicious activity

## Scope

This security policy applies to:
- The `mcp-lite` npm package
- The GitHub repository

It does NOT apply to:
- Third-party packages that depend on mcp-lite
- Applications built with mcp-lite

## Updates

Security updates will be released as patch versions (e.g., 0.1.1, 0.1.2).

Subscribe to [GitHub releases](https://github.com/srsergi0/mcp-lite/releases) to be notified of updates.
