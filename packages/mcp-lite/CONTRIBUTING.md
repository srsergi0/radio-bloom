# Contributing to mcp-lite

Thanks for your interest in contributing to mcp-lite! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and inclusive in all interactions. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/srsergi0/mcp-lite/issues) to avoid duplicates
2. Open a new issue with a clear title and description
3. Include:
   - Your environment (Bun version, OS)
   - Steps to reproduce
   - Expected vs actual behavior
   - Minimal code example if possible

### Suggesting Features

1. Open an issue with the `feature-request` label
2. Describe the use case (not just the solution)
3. Explain why this would benefit other users

### Submitting Code

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run typecheck: `bun tsc --noEmit`
5. Run tests: `bun test`
6. Commit with a clear message
7. Push and open a Pull Request

## Development Setup

```bash
# Clone the repo
git clone https://github.com/srsergi0/mcp-lite.git
cd mcp-lite

# Install dependencies
bun install

# Run typecheck
bun tsc --noEmit

# Run tests
bun test

# Start development
bun run dev
```

## Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Keep functions small and focused
- Add JSDoc comments for public APIs
- No comments unless asked (per AGENTS.md)

## Testing

- Write tests for new features
- Ensure all existing tests pass
- Test with both Zod v3 and v4 when possible

## Pull Request Checklist

- [ ] Code compiles without errors
- [ ] All tests pass
- [ ] Documentation updated (if applicable)
- [ ] No breaking changes (or clearly documented)
- [ ] Commit messages are clear and descriptive

## Questions?

Open an issue with the `question` label or reach out on [Discord](https://discord.gg/mcp).

Thank you for contributing!
