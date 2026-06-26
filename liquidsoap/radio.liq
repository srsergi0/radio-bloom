# Radio Bloom - Liquidsoap Configuration

settings.server.telnet := true
settings.server.telnet.port := 1234
settings.server.telnet.bind_addr := "0.0.0.0"

# Background playlist (always available when queue is empty)
music = playlist(mode="randomize", reload=30, "/music/songs/")
radio = crossfade(duration=3.0, music)
radio = mksafe(radio)

# User queue for on-demand tracks
queue = request.queue(id="queue")

# Fallback: queue takes priority, radio is backup
main = fallback(track_sensitive=false, [queue, radio])

output.harbor(
  %mp3(bitrate=320, samplerate=44100, stereo=true),
  port=8000,
  mount="radiobloom.mp3",
  main
)
