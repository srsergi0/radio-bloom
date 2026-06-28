FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir SpotiFLAC

COPY server.py .

ENV PORT=4002
ENV SONGS_DIR=/music/songs
EXPOSE 4002

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:$PORT/health')"

CMD ["python", "server.py"]
