# Security: No Hardcoded Credentials

Never write credentials, API keys, tokens, or passwords in source files, config files, or documentation. 

- Use `.env` files for secrets
- Never commit `.env` files (already in `.gitignore`)
- Pass sensitive values via environment variables in `docker-compose.yml`
- If you see hardcoded credentials, remove them immediately

This project uses Docker environment variables for all secrets (Spotify tokens, FTP passwords, etc.).

# TypeScript and Tooling Execution

To keep compilation, linting, and type checking ultra-fast, follow these guidelines:

- **Type Checking:**
  - TypeScript incremental mode is enabled in `tsconfig.json`, storing the build cache in `node_modules/.cache/tsconfig.tsbuildinfo`.
  - Always run type checking locally using:
    ```bash
    bun tsc --noEmit
    ```
  - Do **not** use `bun x tsc --noEmit` as it introduces package resolution overhead.
  - If you only want to see errors from specific folders (e.g. `infrastructure`, `services`, `api`, `repositories`), use the incremental `bun tsc --noEmit` command and filter the output (e.g., piping to `Select-String` or `grep`), or let the incremental compilation quickly report all errors.
  - For continuous type checking during development, run:
    ```bash
    bun tsc --noEmit --watch
    ```

- **Formatting & Linting:**
  - Biome is used for ultra-fast formatting and syntax linting (it does not perform type checking).
  - Run Biome commands via the defined package scripts:
    - `bun run lint`
    - `bun run format`
    - `bun run check`

