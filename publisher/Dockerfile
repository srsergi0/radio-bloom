FROM spotdl/spotify-downloader:latest

RUN wget -qO /tmp/bun.zip https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && mv /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun \
    && chmod +x /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
