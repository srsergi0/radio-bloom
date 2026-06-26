FROM oven/bun:1.2-alpine

RUN apk add --no-cache curl python3 py3-pip ffmpeg
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install spotdl

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
