import { useState, useRef, useCallback } from "react";

const getMp3Encoder = () => (window as any).lamejs?.Mp3Encoder;

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const Kbps = 320;
const PCM_BLOCK = 1152;

export default function LiveStream() {
  const API_BASE =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? "http://localhost:9876"
      : "";

  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [elapsed, setElapsed] = useState(0);
  const [format, setFormat] = useState("—");

  const streamRef = useRef<MediaStream | null>(null);
  const encoderRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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

  const sendChunk = async (data: Uint8Array) => {
    try {
      await fetch(`${API_BASE}/api/live/chunk`, {
        method: "POST",
        headers: { "Content-Type": "audio/mpeg" },
        body: data,
      });
    } catch {}
  };

  const stopCapture = useCallback(() => {
    if (processorRef.current && audioCtxRef.current) {
      processorRef.current.disconnect();
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (encoderRef.current) {
      const last = encoderRef.current.flush();
      if (last.length > 0) {
        sendChunk(new Uint8Array(last));
      }
      encoderRef.current = null;
    }

    fetch(`${API_BASE}/api/live/stop`, { method: "POST" }).catch(() => {});
  }, [API_BASE]);

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
      setStatus("No audio track in shared content");
      return;
    }

    setStreaming(true);
    setFormat("MP3 320kbps 44100Hz");
    setStatus("Encoding and streaming...");
    streamRef.current = mediaStream;
    startTimer();

    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(mediaStream);
    sourceRef.current = source;

    const Mp3Encoder = getMp3Encoder();
    if (!Mp3Encoder) {
      setStatus("lamejs not loaded yet, retry");
      return;
    }
    const encoder = new Mp3Encoder(CHANNELS, SAMPLE_RATE, Kbps);
    encoderRef.current = encoder;

    const processor = audioCtx.createScriptProcessor(4096, CHANNELS, CHANNELS);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;

      const left = input.getChannelData(0);
      const right = input.getChannelData(1);
      const len = input.length;

      const leftInt = new Int16Array(len);
      const rightInt = new Int16Array(len);

      for (let i = 0; i < len; i++) {
        leftInt[i] = Math.max(-32768, Math.min(32767, left[i] * 32768));
        rightInt[i] = Math.max(-32768, Math.min(32767, right[i] * 32768));
      }

      for (let i = 0; i < len; i += PCM_BLOCK) {
        const end = Math.min(i + PCM_BLOCK, len);
        const leftChunk = leftInt.subarray(i, end);
        const rightChunk = rightInt.subarray(i, end);
        const mp3 = encoder.encodeBuffer(leftChunk, rightChunk);
        if (mp3.length > 0) {
          sendChunk(new Uint8Array(mp3));
        }
      }
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    setStatus("Streaming live");
  };

  const stopStreaming = () => {
    stopCapture();
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
        Click "Start Streaming" and select a tab/window to share its audio.
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
          <span
            className={
              status === "Streaming live"
                ? "text-green-400"
                : status === "Stopped"
                  ? "text-zinc-500"
                  : "text-yellow-400"
            }
          >
            {status}
          </span>
        </div>
        <div>
          Streaming: <span>{streaming ? fmt(elapsed) : "—"}</span>
        </div>
        <div>
          Audio format: <span>{format}</span>
        </div>
      </div>
    </main>
  );
}
