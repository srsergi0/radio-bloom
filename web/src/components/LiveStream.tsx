import { useState, useRef, useCallback } from "react";

function wsUrl(): string {
  const loc = window.location;
  if (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") {
    return "ws://localhost:9876/ws/live";
  }
  return `wss://${loc.host}/ws/live`;
}

export default function LiveStream() {
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [elapsed, setElapsed] = useState(0);
  const [format, setFormat] = useState("—");

  const wsRef = useRef<WebSocket | null>(null);
  const encoderRef = useRef<AudioEncoder | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const aacConfigRef = useRef<{
    samplerate: number;
    channels: number;
    profile: number;
  } | null>(null);

  const startTimer = () => {
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  };

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setElapsed(0);
  };

  const buildAdts = (frameSize: number): Uint8Array => {
    const cfg = aacConfigRef.current!;
    const profile = cfg.profile; // 2 = AAC-LC
    const srIdx = cfg.samplerate;
    const chanCfg = cfg.channels;
    const fullLen = frameSize + 7;

    const buf = new Uint8Array(7);
    // Syncword 0xFFF
    buf[0] = 0xFF;
    buf[1] = 0xF0 | (0 << 3) | (0 << 1) | 1; // ID=0(MPEG4), layer=0, protection=1
    buf[2] = (profile - 1) << 6 | (srIdx << 2) | (chanCfg >> 2);
    buf[3] = (chanCfg & 3) << 6 | (fullLen >> 11);
    buf[4] = (fullLen >> 3) & 0xFF;
    buf[5] = ((fullLen & 7) << 5) | 0x1F;
    buf[6] = 0xFC;
    return buf;
  };

  const cleanup = useCallback(() => {
    if (readerRef.current) {
      readerRef.current.cancel().catch(() => {});
      readerRef.current = null;
    }
    if (encoderRef.current) {
      encoderRef.current.close();
      encoderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    aacConfigRef.current = null;
  }, []);

  const startStreaming = async () => {
    let mediaStream: MediaStream;
    try {
      mediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
        audio: true,
        video: true,
      });
      mediaStream.getVideoTracks().forEach((t) => t.stop());
    } catch (err: any) {
      setStatus("Cancelled: " + err.message);
      return;
    }
    if (!mediaStream.getAudioTracks().length) {
      setStatus("No audio track");
      return;
    }

    setStatus("Connecting...");
    streamRef.current = mediaStream;

    // WebSocket
    const ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS timeout")), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("WS error")); };
    });
    wsRef.current = ws;

    // WebCodecs: get raw PCM track
    const track = mediaStream.getAudioTracks()[0];
    const processor = new (window as any).MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    readerRef.current = reader;

    // AudioEncoder: encode to AAC
    const encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk) => {
        const cfg = aacConfigRef.current;
        if (!cfg) return;
        const adts = buildAdts(chunk.byteLength);
        const aacData = new Uint8Array(chunk.byteLength + 7);
        aacData.set(adts, 0);
        chunk.copyTo(aacData.subarray(7));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(aacData);
        }
      },
      error: (e: Error) => {
        console.error("AudioEncoder error:", e);
      },
    });

    const trackSettings = track.getSettings?.() || {};
    const sampleRate = trackSettings.sampleRate || 48000;
    const channels = trackSettings.channelCount || 2;

    // Map sample rate to ADTS index
    const srMap: Record<number, number> = {
      96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4,
      32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9,
      11025: 10, 8000: 11, 7350: 12,
    };
    const srIdx = srMap[sampleRate] ?? 4;

    aacConfigRef.current = {
      samplerate: srIdx,
      channels,
      profile: 2, // AAC-LC
    };

    encoder.configure({
      codec: "mp4a.40.2",
      sampleRate,
      numberOfChannels: channels,
      bitrate: 192_000,
    });
    encoderRef.current = encoder;

    setStreaming(true);
    setFormat(`AAC 192kbps ${sampleRate}Hz`);

    // Read PCM frames and feed to encoder
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // value is AudioData (PCM)
          encoder.encode(value);
          value.close();
        }
      } catch {}
    };
    pump();

    setStatus("Streaming live");
    startTimer();
  };

  const stopStreaming = () => {
    cleanup();
    stopTimer();
    setStreaming(false);
    setStatus("Stopped");
  };

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="max-w-xl mx-auto px-6 py-16 space-y-8">
      <h1 className="text-4xl font-black uppercase tracking-tight">Live Broadcast</h1>
      <p className="text-zinc-400">
        Click "Start Streaming" and select a tab to share its audio. WebCodecs encode.
      </p>
      <div className="space-y-6 border-2 border-white p-6">
        <div className="flex gap-4">
          <button
            className="flex-1 border-2 border-white px-6 py-3 font-bold uppercase tracking-wider hover:bg-white hover:text-black disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={streaming}
            onClick={startStreaming}
          >
            Start Streaming
          </button>
          <button
            className="flex-1 border-2 border-red-500 text-red-500 px-6 py-3 font-bold uppercase tracking-wider hover:bg-red-500 hover:text-black disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={!streaming}
            onClick={stopStreaming}
          >
            Stop
          </button>
        </div>
      </div>
      <div className="border-2 border-zinc-800 p-4 font-mono text-sm space-y-1">
        <div>
          Status:{" "}
          <span className={
            status === "Streaming live"
              ? "text-green-400"
              : status === "Stopped"
                ? "text-zinc-500"
                : "text-yellow-400"
          }>
            {status}
          </span>
        </div>
        <div>Streaming: <span>{streaming ? fmt(elapsed) : "—"}</span></div>
        <div>Audio format: <span>{format}</span></div>
      </div>
    </main>
  );
}
