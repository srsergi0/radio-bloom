# Radio Bloom - Liquidsoap Configuration

settings.server.telnet := true
settings.server.telnet.port := 1234
settings.server.telnet.bind_addr := "0.0.0.0"
settings.harbor.bind_addrs := ["0.0.0.0"]

# Background playlist (always available when queue is empty)
# conservative=true avoids re-encoding when codec matches output
music = playlist(mode="randomize", reload=60, "/music/songs/")
radio = crossfade(duration=3.0, music)
radio = mksafe(radio)

# User queue for on-demand tracks (timeout=10s to prevent stuck requests)
queue = request.queue(id="queue", timeout=10.)

# Live input via Icecast (Harbor)
live = input.harbor(
  "live",
  port=8001,
  password="radiobloom_live",
  buffer=5.0,
  max=10.0
)

# Fallback: live takes priority, then queue, then radio
main = fallback(track_sensitive=false, [live, queue, radio])

# Audio Processing Pipeline (Broadcasting DSP - Commercial FM Sound)
main = normalize(target=-14.0, threshold=-45.0, main)

main = compress.multiband(main, [
  {frequency=200., attack=10.0, release=100.0, ratio=3.5, threshold=-16.0, gain=3.0},
  {frequency=3000., attack=5.0, release=70.0, ratio=2.5, threshold=-18.0, gain=2.0},
  {frequency=20000., attack=2.0, release=50.0, ratio=3.0, threshold=-12.0, gain=1.5}
])

main = limit(main, threshold=-1.0)

output.harbor(
  %mp3(bitrate=320, samplerate=44100, stereo=true, internal_quality=0),
  port=8000,
  mount="radiobloom.mp3",
  main
)
