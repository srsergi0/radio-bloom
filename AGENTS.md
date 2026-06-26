# Security: No Hardcoded Credentials

Never write credentials, API keys, tokens, or passwords in source files, config files, or documentation. 

- Use `.env` files for secrets
- Never commit `.env` files (already in `.gitignore`)
- Pass sensitive values via environment variables in `docker-compose.yml`
- If you see hardcoded credentials, remove them immediately

This project uses Docker environment variables for all secrets (Spotify tokens, FTP passwords, etc.).
