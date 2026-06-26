FROM spotdl/spotify-downloader:latest

RUN apt-get update -qq && apt-get install -y -qq curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
