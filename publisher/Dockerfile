# Stage 1: Build the Astro landing page
FROM oven/bun:1.2-alpine AS web-builder
WORKDIR /app/web

COPY web/package.json web/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install 2>&1

COPY web/ .
RUN bun run build

# Stage 2: Run the publisher
FROM oven/bun:1.2-alpine

RUN apk add --no-cache aria2 ffmpeg

WORKDIR /app/publisher

# Only publisher deps — no workspace resolution, no web/React/Astro bloat
COPY publisher/package.json publisher/bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production 2>&1

COPY publisher/ .

# Copy Astro static build
COPY --from=web-builder /app/web/dist /app/web/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
