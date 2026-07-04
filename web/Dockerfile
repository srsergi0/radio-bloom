# Build stage
FROM oven/bun:1.2-alpine AS builder
WORKDIR /app

COPY web/package.json web/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install 2>&1

COPY web/ .
RUN bun run build

# Production stage
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
