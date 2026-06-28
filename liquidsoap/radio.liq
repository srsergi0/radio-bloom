# Radio Bloom - Liquidsoap Configuration

settings.server.telnet := true
settings.server.telnet.port := 1234
settings.server.telnet.bind_addr := "0.0.0.0"

# ============================================================
# Live Input (recibe audio desde tu PC vía BUTT/FFmpeg/OBS)
# ============================================================
live_input = input.harbor(
  id="live_input",
  port=8001,
  mount="/live.mp3",
  format="mp3",
  max=30.
)

# Control de modo live vía telnet
live_active = ref(false)
server.register(namespace="live", "active",
  "Get/set live mode (true=live on, false=queue+playlist)",
  { fun (s) -> live_active := bool_of_string(s) },
  { fun () -> string_of_bool(!live_active) }
)
server.register(namespace="live", "connected",
  "Check if live input is receiving data (read-only)",
  { fun (_) -> "read-only" },
  { fun () -> string_of_bool(source.is_ready(live_input)) }
)

# ============================================================
# Background playlist (siempre disponible cuando la cola está vacía)
# ============================================================
music = playlist(mode="randomize", reload=30, "/music/songs/")
radio = crossfade(duration=3.0, music)
radio = mksafe(radio)

# ============================================================
# User queue for on-demand tracks
# ============================================================
queue = request.queue(id="queue")

# ============================================================
# Normal mode: queue takes priority, radio is backup
# ============================================================
normal = fallback(track_sensitive=false, [queue, radio])

# ============================================================
# Live Switch: live solo cuando está activo Y hay conexión
# fallback interno: si live_input no recibe datos (desconectado),
# cae automáticamente a normal sin silencio
# ============================================================
live_with_fallback = fallback(track_sensitive=false, [live_input, normal])
main = switch(track_sensitive=false, [
  ({ live_active }, live_with_fallback),
  ({ true }, normal)
])

# ============================================================
# Audio Processing Pipeline (Broadcasting DSP)
# ============================================================
main = normalize(target=-14.0, threshold=-45.0, main)
main = compress(main, attack=5.0, gain=3.0, ratio=2.5, release=150.0, threshold=-16.0)
main = limit(main, threshold=-1.0)

# ============================================================
# Output (siempre por /radiobloom.mp3)
# ============================================================
output.harbor(
  %mp3(bitrate=320, samplerate=44100, stereo=true, internal_quality=0),
  port=8000,
  mount="radiobloom.mp3",
  main
)
