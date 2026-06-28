import { useState, useRef, useCallback } from "react";

const getMp3Encoder = () => (window as any).lamejs?.Mp3Encoder;

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const Kbps = 320;
const PCM_BLOCK = 1152;

function wsUrl(): string {
  const loc = window.location;
  if (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") {
    return "ws://localhost:9876/ws/live";
  }
  return `wss://${loc.host}/ws/live`;
}

function apiBase(): string {
  const loc = window.location;
  if (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") {
    return "http://localhost:9876";
  }
  return "";
}

export default function LiveStream() {
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [elapsed, setElapsed] = useState(0);
  const [format, setFormat] = useState("—");

  const wsRef = useRef<WebSocket | null>(null);
  const encoderRef = useRef<any>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);

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

  const cleanup = useCallback(() => {
    // Close processor
    if (processorRef.current && ctxRef.current) {
      processorRef.current.disconnect();
    }
    // Close audio context
    if (ctxRef.current) {
      ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    // Stop tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    // Flush encoder
    if (encoderRef.current) {
      const last = encoderRef.current.flush();
      if (last.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(last);
      }
      encoderRef.current = null;
    }
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const startStreaming = async () => {
    // 1. Screen share
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

    // 2. Connect WebSocket
    const ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS timeout")), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("WS error")); };
    });

    wsRef.current = ws;

    // 3. Setup MP3 encoder
    const Mp3Encoder = getMp3Encoder();
    if (!Mp3Encoder) {
      setStatus("lamejs not loaded");
      cleanup();
      return;
    }
    const encoder = new Mp3Encoder(CHANNELS, SAMPLE_RATE, Kbps);
    encoderRef.current = encoder;

    // 4. Audio pipeline with larger buffer for stability
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    ctxRef.current = ctx;

    const source = ctx.createMediaStreamSource(mediaStream);
    sourceRef.current = source;

    const processor = ctx.createScriptProcessor(16384, CHANNELS, CHANNELS);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const len = input.length;
      const left = input.getChannelData(0);
      const right = input.getChannelData(1);

      const leftInt = new Int16Array(len);
      const rightInt = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        leftInt[i] = Math.max(-32768, Math.min(32767, left[i] * 32768));
        rightInt[i] = Math.max(-32768, Math.min(32767, right[i] * 32768));
      }

      for (let i = 0; i < len; i += PCM_BLOCK) {
        const end = Math.min(i + PCM_BLOCK, len);
        const mp3 = encoder.encodeBuffer(
          leftInt.subarray(i, end),
          rightInt.subarray(i, end)
        );
        if (mp3.length > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(mp3);
        }
      }
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    setStreaming(true);
    setFormat("MP3 320kbps 44100Hz");
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
        Click "Start Streaming" and select a tab to share its audio. High quality, no cables.
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
