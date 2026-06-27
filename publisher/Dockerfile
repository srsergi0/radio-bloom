FROM oven/bun:1.2-alpine

RUN apk add --no-cache python3 py3-pip py3-setuptools ffmpeg && \
    pip3 install --break-system-packages spotdl

WORKDIR /app/publisher

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
