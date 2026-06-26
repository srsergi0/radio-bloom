FROM oven/bun:1.2-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

CMD ["bun", "src/index.ts"]
