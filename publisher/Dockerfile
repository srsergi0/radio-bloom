# Stage 1: Build the Astro landing page
FROM oven/bun:1.2-alpine AS web-builder
WORKDIR /app/web

COPY web/package.json web/bun.lock* ./
# Usamos caché de BuildKit para la instalación de paquetes de Bun
RUN --mount=type=cache,target=/root/.bun/install/cache bun install 2>&1

COPY web/ .
RUN bun run build

# Stage 2: Run the publisher
FROM oven/bun:1.2-alpine

WORKDIR /app/publisher

COPY publisher/package.json publisher/bun.lock* ./
# Usamos caché de BuildKit e instalamos SOLO dependencias de producción para aligerar la imagen
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production 2>&1

COPY publisher/ .

# Copiar los archivos estáticos de Astro generados en la Stage 1
COPY --from=web-builder /app/web/dist /app/web/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
