import { useState, useRef, useCallback, useEffect } from "react";

// Mp3Encoder de lamejs (cargado via /scripts/lame.all.js)
declare const Mp3Encoder: any;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const Kbps = 192;
const PCM_BLOCK = 1152;

export default function LiveStream() {
  const API_BASE =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? "http://localhost:9876"
      : "";
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [elapsed, setElapsed] = useState(0);
  const [format, setFormat] = useState("—");

  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const encoderRef = useRef<Mp3Encoder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const bufferRef = useRef<Int16Array[]>([]);

  const loadDevices = useCallback(async () => {
    try {
      let permStream: MediaStream | null = null;
      try {
        permStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {}

      const all = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = all.filter((d) => d.kind === "audioinput");
      setDevices(audioInputs);

      if (permStream) permStream.getTracks().forEach((t) => t.stop());
    } catch {}
  }, []);

  useEffect(() => {
    loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", loadDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
  }, [loadDevices]);

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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (encoderRef.current) {
      const last = encoderRef.current.flush();
      if (last.length > 0) {
        sendChunk(new Uint8Array(last));
      }
      encoderRef.current = null;
    }
    bufferRef.current = [];

    fetch(`${API_BASE}/api/live/stop`, { method: "POST" }).catch(() => {});
  }, []);

  const sendChunk = async (data: Uint8Array) => {
    try {
      await fetch(`${API_BASE}/api/live/chunk`, {
        method: "POST",
        headers: { "Content-Type": "audio/mpeg" },
        body: data,
      });
    } catch {}
  };

  const startStreaming = async () => {
    // Screen share with audio
    let mediaStream: MediaStream;
    try {
      mediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
        audio: true,
        video: true,
      });

      // Stop video track immediately — we only want audio
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
    setFormat("MP3 192kbps");
    setStatus("Encoding and streaming...");
    streamRef.current = mediaStream;
    startTimer();

    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(mediaStream);
    sourceRef.current = source;

    const encoder = new Mp3Encoder(CHANNELS, SAMPLE_RATE, Kbps);
    encoderRef.current = encoder;

    const processor = audioCtx.createScriptProcessor(4096, CHANNELS, CHANNELS);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;

      if (CHANNELS === 2) {
        const left = input.getChannelData(0);
        const right = input.getChannelData(1);
        const len = input.length;

        const leftInt = new Int16Array(len);
        const rightInt = new Int16Array(len);

        for (let i = 0; i < len; i++) {
          leftInt[i] = Math.max(-32768, Math.min(32767, left[i] * 32768));
          rightInt[i] = Math.max(-32768, Math.min(32767, right[i] * 32768));
        }

        // Encode in blocks of PCM_BLOCK
        for (let i = 0; i < len; i += PCM_BLOCK) {
          const end = Math.min(i + PCM_BLOCK, len);
          const leftChunk = leftInt.subarray(i, end);
          const rightChunk = rightInt.subarray(i, end);
          const mp3 = encoder.encodeBuffer(leftChunk, rightChunk);
          if (mp3.length > 0) {
            sendChunk(new Uint8Array(mp3));
          }
        }
      } else {
        const mono = input.getChannelData(0);
        const len = input.length;
        const monoInt = new Int16Array(len);

        for (let i = 0; i < len; i++) {
          monoInt[i] = Math.max(-32768, Math.min(32767, mono[i] * 32768));
        }

        for (let i = 0; i < len; i += PCM_BLOCK) {
          const end = Math.min(i + PCM_BLOCK, len);
          const chunk = monoInt.subarray(i, end);
          const mp3 = encoder.encodeBuffer(chunk);
          if (mp3.length > 0) {
            sendChunk(new Uint8Array(mp3));
          }
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

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  return (
    <main className="max-w-xl mx-auto px-6 py-16 space-y-8">
      <h1 className="text-4xl font-black uppercase tracking-tight">Live Broadcast</h1>
      <p className="text-zinc-400">
        Share your screen/tab audio directly to the radio. No cables needed.
      </p>

      <div className="space-y-6 border-2 border-white p-6">
        <div className="space-y-2">
          <label className="text-sm font-bold uppercase tracking-wider">Audio Device</label>
          <select
            className="w-full border-2 border-white bg-black p-3 text-white"
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
          >
            <option value="">— Share screen audio (no device needed) —</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </div>

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
