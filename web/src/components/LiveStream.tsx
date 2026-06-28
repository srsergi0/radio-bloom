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
  const ctxRef = useRef<AudioContext | null>(null);
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
    if (processorRef.current && ctxRef.current) {
      processorRef.current.disconnect();
    }
    if (ctxRef.current) {
      ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
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
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("WS timeout")), 5000);
        ws.onopen = () => { clearTimeout(t); resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error("WS failed")); };
      });
    } catch (err: any) {
      setStatus(err.message);
      mediaStream.getTracks().forEach((t) => t.stop());
      return;
    }
    wsRef.current = ws;

    // Capture PCM and send raw Float32 via WebSocket
    const ctx = new AudioContext();
    ctxRef.current = ctx;

    const source = ctx.createMediaStreamSource(mediaStream);
    const processor = ctx.createScriptProcessor(4096, 2, 2);
    processorRef.current = processor;

    // Mute output, keep graph alive
    const mute = ctx.createGain();
    mute.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const left = input.getChannelData(0);
      const right = input.getChannelData(1);
      const len = input.length;

      // Interleave stereo
      const interleaved = new Float32Array(len * 2);
      for (let i = 0; i < len; i++) {
        interleaved[i * 2] = left[i];
        interleaved[i * 2 + 1] = right[i];
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(interleaved.buffer);
      }
    };

    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    setStreaming(true);
    setFormat(`PCM f32le → MP3 (server encode)`);
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
        Click "Start Streaming" and select a tab to share its audio.
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
