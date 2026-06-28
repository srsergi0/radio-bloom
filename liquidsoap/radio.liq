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

# Audio Processing Pipeline (Broadcasting DSP)
main = normalize(target=-14.0, threshold=-45.0, main)
main = compress(main, attack=5.0, gain=3.0, ratio=2.5, release=150.0, threshold=-16.0)
main = limit(main, threshold=-1.0)

output.harbor(
  %mp3(bitrate=320, samplerate=44100, stereo=true, internal_quality=0),
  port=8000,
  mount="radiobloom.mp3",
  main
)
