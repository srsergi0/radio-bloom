FROM python:3.12-slim

WORKDIR /app

# Usamos caché de BuildKit para acelerar pip install
RUN --mount=type=cache,target=/root/.cache/pip pip install SpotiFLAC

COPY server.py .

ENV PORT=4002
ENV SONGS_DIR=/music/songs
EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:$PORT/health')"

CMD ["python", "server.py"]
