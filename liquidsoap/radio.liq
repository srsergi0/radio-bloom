# Radio Bloom - Liquidsoap Configuration

settings.server.telnet := true
settings.server.telnet.port := 1234
settings.server.telnet.bind_addr := "0.0.0.0"

# ============================================================
# Live Input: detecta conexión entrante y se swichea automático
# ============================================================
live_input = input.harbor("/live.mp3", port=8001, user="source", password="hackme")

server.register(namespace="live", "connected",
  fun (_) -> if source.is_ready(live_input) then "true" else "false" end
)

# ============================================================
# Background playlist
# ============================================================
music = playlist(mode="randomize", reload=30, "/music/songs/")
radio = crossfade(duration=3.0, music)
radio = mksafe(radio)

# ============================================================
# User queue for on-demand tracks
# ============================================================
queue = request.queue(id="queue")

# ============================================================
# Normal mode
# ============================================================
normal = fallback(track_sensitive=false, [queue, radio])

# ============================================================
# Auto-switch: live_input tiene prioridad. Cuando un cliente
# se conecta al harbor, suena en vivo. Cuando se desconecta,
# vuelve a queue + playlist automáticamente.
# ============================================================
main = fallback(track_sensitive=false, [live_input, normal])

# ============================================================
# Audio Processing Pipeline
# ============================================================
main = normalize(target=-14.0, threshold=-45.0, main)
main = compress(main, attack=5.0, gain=3.0, ratio=2.5, release=150.0, threshold=-16.0)
main = limit(main, threshold=-1.0)

# ============================================================
# Output (único endpoint /radiobloom.mp3)
# ============================================================
output.harbor(
  %mp3(bitrate=320, samplerate=44100, stereo=true, internal_quality=0),
  port=8000,
  mount="radiobloom.mp3",
  main
)
