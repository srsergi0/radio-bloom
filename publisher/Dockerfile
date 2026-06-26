FROM spotdl/spotify-downloader:latest

RUN wget -qO- https://bun.sh/install | sh
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["bun", "src/index.ts"]
