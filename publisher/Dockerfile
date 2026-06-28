# Stage 1: Build the Astro landing page
FROM oven/bun:1.2-alpine AS web-builder
WORKDIR /app/web

COPY web/package.json web/bun.lock* ./
# Usamos caché de BuildKit para la instalación de paquetes de Bun
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile 2>/dev/null || bun install

COPY web/ .
RUN bun run build

# Stage 2: Run the publisher
FROM oven/bun:1.2-alpine

# Usamos caché de BuildKit para los paquetes apk de Alpine
RUN --mount=type=cache,target=/var/cache/apk apk add --no-cache ffmpeg

WORKDIR /app/publisher

COPY publisher/package.json publisher/bun.lock* ./
# Usamos caché de BuildKit e instalamos SOLO dependencias de producción para aligerar la imagen
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile 2>/dev/null || bun install --production

COPY publisher/ .

# Copiar los archivos estáticos de Astro generados en la Stage 1
COPY --from=web-builder /app/web/dist /app/web/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
