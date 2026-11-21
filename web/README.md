# Bloom Radio — Web 2.0

Web pública de escucha (Astro estático + islas React). Español en `/`, inglés en `/en/`.

## Qué hace

- **Escenario en vivo**: visualizador "bloom" (canvas + Web Audio sobre el stream real), portada, título, locutor en cabina y oyentes.
- **Sincronía con el audio**: el stream llega con retraso (prebuffer); los metadatos se muestran con ese mismo retraso medido en el navegador (`buffered.end − currentTime`), así el título cambia cuando de verdad cambia la canción.
- **Tiempo real** por SSE (`/api/live/events`) con fallback a polling.
- **Programación** semanal real (`/api/live/schedule`), historial, lo que viene.
- Color de la escena extraído de la portada; Media Session (pantalla de bloqueo); PWA instalable; atajo de teclado (Espacio).

## Estructura

```
src/
├── pages/index.astro, pages/en/index.astro   # ES (default) / EN
├── layouts/Layout.astro                      # <head>, SEO, OG, manifest, SW
├── components/
│   ├── Home.astro            # composición de la página
│   ├── Station.tsx           # escenario + controles (client:load)
│   ├── BloomVisualizer.tsx   # canvas de la flor
│   ├── Feed.tsx              # lo que viene + historial (client:only)
│   ├── Schedule.tsx          # parrilla semanal (client:only)
│   ├── MiniPlayer.tsx        # barra inferior + botón de cabecera
│   ├── Cover.tsx, Icons.tsx, Logo.astro
│   └── Header/Footer/HowItWorks/Anywhere.astro
├── lib/
│   ├── live.ts     # store en vivo: SSE, snapshots con retraso, historial, parrilla
│   ├── player.ts   # <audio> único, reconexión, medición de lag, analizador
│   ├── store.ts    # store observable compartido entre islas
│   ├── color.ts, format.ts, i18n.ts, types.ts (contrato de /api/live/*)
└── styles/global.css
```

## Desarrollo

Sin bun en el host: `docker run --rm -v "$PWD":/app -w /app oven/bun:1.2-alpine sh -c "bun install && bun run build"`.
En dev, Vite hace proxy de `/api` y `/radiobloom*` al publisher (`127.0.0.1:9876`).

## Producción

`docker compose up -d --build web` (nginx sirve `dist/` y hace proxy de `/api/`, `/api/live/events` sin buffer y de los streams `/radiobloom*`).
