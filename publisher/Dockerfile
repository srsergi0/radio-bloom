FROM spotdl/spotify-downloader:latest AS spotdl

FROM oven/bun:1.2-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg

COPY --from=spotdl /app/.venv /opt/venv
COPY --from=spotdl /app/spotdl /opt/venv/spotdl
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
