# Stage 1: Build the Astro landing page
FROM oven/bun:1.2-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY web/ .
RUN bun run build

# Stage 2: Run the publisher
FROM oven/bun:1.2-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app/publisher

COPY publisher/package.json publisher/bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY publisher/ .

# Copy the built Astro static files from Stage 1
COPY --from=web-builder /app/web/dist /app/web/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
