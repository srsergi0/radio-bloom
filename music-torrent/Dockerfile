FROM python:3.12-alpine

RUN apk add --no-cache \
    aria2 \
    ffmpeg \
    ffmpeg-dev \
    py3-pip

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENTRYPOINT ["python", "main.py"]
