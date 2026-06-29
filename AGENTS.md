# Security: No Hardcoded Credentials

Never write credentials, API keys, tokens, or passwords in source files, config files, or documentation. 

- Use `.env` files for secrets
- Never commit `.env` files (already in `.gitignore`)
- Pass sensitive values via environment variables in `docker-compose.yml`
- If you see hardcoded credentials, remove them immediately

This project uses Docker environment variables for all secrets (Spotify tokens, FTP passwords, etc.).

# Git: No Auto-Commit or Push

Never commit or push changes unless explicitly asked by the user. Even then, ask for double confirmation before executing:

1. Show a summary of what will be committed (files and changes)
2. Ask explicitly: "¿Confirmas el commit y push?"
3. Only proceed after receiving explicit "yes" or "si"

This applies to all situations including fixes, features, experiments, and WIP. No exceptions.

If a commit was just made without permission, apologize and follow the rule going forward.

# Subproject AGENTS.md

This repo uses nested AGENTS.md files for subproject-specific instructions:

- `publisher/AGENTS.md` — Backend (Bun + TypeScript, Biome, build commands, architecture)
- `web/AGENTS.md` — Frontend (Astro, dev server, component conventions)

The closest AGENTS.md to the file being edited takes precedence. Root rules (this file) apply everywhere.

# Project Map: BITACORA.md

- **First Step for Agents**: When starting to work on this project to understand its structure, scope, and key files, the first file you MUST read is `BITACORA.md`.
- **Maintenance**: Whenever you create, modify, or delete files, you MUST update `BITACORA.md` to reflect any changes to the project's structure, files, or component connections. Only log useful/relevant changes that help future agents understand the project.

# BITACORA.md Update Checklist

**IMPORTANT**: After ANY code change (new feature, refactor, bugfix), you MUST:

1. **Update file descriptions** in the tree if files were added/removed/renamed
2. **Add new API endpoints** to the relevant table if endpoints were added/modified
3. **Document new services/methods** if business logic was added
4. **Update the workflow section** if data flow changed
