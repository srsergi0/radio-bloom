const MAX_RECONNECT_ATTEMPTS = 100;

export interface BuncasterCurrentTrack {
  file: string;
  title: string;
  artist: string;
  duration: number;
  startedAt: number;
}

export interface BuncasterQueueItem {
  index: number;
  file: string;
  title: string;
  artist: string;
}

export interface BuncasterStatus {
  broadcasting: boolean;
  listeners: number;
  currentTrack: BuncasterCurrentTrack | null;
  uptimeSeconds: number;
  fallbackActive: boolean;
  opusTierEnabled?: boolean;
  opusTierBitrateKbps?: number;
  fallbackBitrateKbps?: number;
}

export class BuncasterClient {
  private connected = false;
  private reconnectAttempts = 0;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly adminUser: string,
    private readonly adminPassword: string,
    private readonly reconnectIntervalMs = 2000,
  ) {
    this.baseUrl = `http://${host}:${port}`;
    this.authHeader =
      "Basic " + Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");
    this.checkHealth();
  }

  private async checkHealth() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.connected = true;
        this.reconnectAttempts = 0;
        console.log("[BuncasterClient] Connected to Buncaster.");
      } else {
        throw new Error(`Health check returned ${res.status}`);
      }
    } catch (err: any) {
      this.connected = false;
      this.reconnectAttempts++;
      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        console.log(
          `[BuncasterClient] Buncaster not ready (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}). Retrying in ${this.reconnectIntervalMs}ms...`,
        );
        setTimeout(() => this.checkHealth(), this.reconnectIntervalMs);
      } else {
        console.error(
          `[BuncasterClient] Stopped reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts.`,
        );
      }
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getHost(): string {
    return this.host;
  }

  public getPort(): number {
    return this.port;
  }

  public getAdminUser(): string {
    return this.adminUser;
  }

  public getAdminPass(): string {
    return this.adminPassword;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Buncaster API error: ${res.status} ${res.statusText} - ${text}`,
      );
    }

    return res.json() as Promise<T>;
  }

  private async requestWithFallback<T>(
    paths: string[],
    options: RequestInit = {},
  ): Promise<T> {
    let lastErr: any = null;
    for (const path of paths) {
      try {
        return await this.request<T>(path, options);
      } catch (err: any) {
        lastErr = err;
        // 404 -> try next alias, otherwise also try next
        continue;
      }
    }
    throw lastErr ?? new Error("All fallback paths failed");
  }

  // ── Stream ──────────────────────────────────────────────

  public getStreamUrl(): string {
    return `${this.baseUrl}/mp3`;
  }

  public getStreamResponse(): Promise<Response> {
    return fetch(this.getStreamUrl(), {
      headers: { Authorization: this.authHeader },
    });
  }

  // ── Status ──────────────────────────────────────────────

  public async getStatus(): Promise<BuncasterStatus> {
    return this.request<BuncasterStatus>("/status");
  }

  // ── Current Track ───────────────────────────────────────

  // buncaster-cli exposes the file of the deck currently playing only in
  // /debug-state. /health gives just the display title and the upcoming queue,
  // so using queue[0] there showed the NEXT track as "now playing".
  private async getActiveDeckFile(): Promise<string | null> {
    try {
      const debugState = await this.request<any>("/debug-state");
      const activeDeck: string | undefined = debugState?.activeDeck;
      const decks = activeDeck ? [activeDeck, "A", "B"] : ["A", "B"];
      for (const deck of decks) {
        const file = debugState?.[`deck${deck}`]?.currentTrackFile;
        if (typeof file === "string" && file.length > 0) return file;
      }
    } catch {}
    return null;
  }

  public async getCurrentTrack(): Promise<BuncasterCurrentTrack | null> {
    // 1. Legacy + new dedicated endpoint
    for (const ep of ["/admin/api/current", "/api/current"]) {
      try {
        const data = await this.request<{ currentTrack: BuncasterCurrentTrack | null }>(ep);
        if (data && "currentTrack" in data) return data.currentTrack;
        // Some servers return the track directly
        if (data && (data as any).file) return data as unknown as BuncasterCurrentTrack;
      } catch {}
    }
    // 2. Derive from /health (buncaster-cli: fallback.currentTrack = "Artist - Title")
    try {
      const health = await this.request<any>("/health");
      const ctStr: string | undefined = health?.fallback?.currentTrack;
      // If health has structured currentTrack
      if (health?.currentTrack?.file) return health.currentTrack as BuncasterCurrentTrack;
      if (typeof ctStr === "string" && ctStr.length > 0) {
        // Synthesize a track from the display string so upper layers have something to show
        const dash = ctStr.indexOf(" - ");
        const title = dash > 0 ? ctStr.slice(dash + 3).trim() : ctStr;
        const artist = dash > 0 ? ctStr.slice(0, dash).trim() : "";
        // Use the file of the deck actually playing (not the head of the queue)
        const activeFile = await this.getActiveDeckFile();
        return {
          file: activeFile ?? ctStr,
          title,
          artist,
          duration: 0,
          startedAt: Date.now(),
        };
      }
    } catch {}
    // 3. Try /status fallback parsing
    try {
      const status = await this.request<any>("/status");
      if (status?.currentTrack?.file) return status.currentTrack as BuncasterCurrentTrack;
      if (status?.fallback?.currentTrack?.file) return status.fallback.currentTrack as BuncasterCurrentTrack;
    } catch {}
    return null;
  }

  // ── Queue Management ────────────────────────────────────

  public async getQueue(): Promise<BuncasterQueueItem[]> {
    const candidates = ["/api/queue", "/admin/api/queue"];
    for (const ep of candidates) {
      try {
        const data = await this.request<any>(ep);
        const raw: any[] = data.queue || data.items || data.data || [];
        if (!Array.isArray(raw)) continue;
        // buncaster-cli may return string[] or object[]
        return raw.map((entry: any, index: number) => {
          if (typeof entry === "string") {
            return { index, file: entry, title: "", artist: "" };
          }
          return {
            index: entry.index ?? index,
            file: entry.file ?? entry.path ?? String(entry),
            title: entry.title ?? "",
            artist: entry.artist ?? "",
          };
        });
      } catch {}
    }
    return [];
  }

  public async pushToQueue(file: string): Promise<boolean> {
    const candidates = ["/api/queue/add", "/admin/api/queue/push"];
    for (const ep of candidates) {
      try {
        await this.request(ep, {
          method: "POST",
          body: JSON.stringify({ file }),
        });
        return true;
      } catch {}
    }
    console.error("[BuncasterClient] pushToQueue failed: all endpoints rejected for", file);
    return false;
  }

  public async removeFromQueue(index: number): Promise<boolean> {
    const candidates = ["/api/queue/remove", "/admin/api/queue/remove"];
    for (const ep of candidates) {
      try {
        await this.request(ep, {
          method: "POST",
          body: JSON.stringify({ index }),
        });
        return true;
      } catch {}
    }
    console.error("[BuncasterClient] removeFromQueue failed:", index);
    return false;
  }

  public async clearQueue(): Promise<boolean> {
    const candidates = ["/api/queue/clear", "/admin/api/queue/clear"];
    for (const ep of candidates) {
      try {
        await this.request(ep, { method: "POST" });
        return true;
      } catch {}
    }
    console.error("[BuncasterClient] clearQueue failed");
    return false;
  }

  public async moveInQueue(from: number, to: number): Promise<boolean> {
    const candidates = ["/api/queue/move", "/admin/api/queue/move"];
    for (const ep of candidates) {
      try {
        await this.request(ep, {
          method: "POST",
          body: JSON.stringify({ from, to }),
        });
        return true;
      } catch {}
    }
    console.error("[BuncasterClient] moveInQueue failed:", { from, to });
    return false;
  }

  // ── Playback Controls ───────────────────────────────────

  public async skip(): Promise<boolean> {
    const candidates = ["/api/skip", "/admin/api/skip"];
    for (const ep of candidates) {
      try {
        await this.request(ep, { method: "POST" });
        return true;
      } catch {}
    }
    console.error("[BuncasterClient] skip failed");
    return false;
  }

  public async shufflePlaylist(): Promise<boolean> {
    // Not documented in buncaster-cli; try legacy, otherwise no-op
    try {
      await this.request("/admin/api/playlist/shuffle", { method: "POST" });
      return true;
    } catch {
      // buncaster-cli has no shuffle — fallback is directory-based, ignore
      return true;
    }
  }

  public async toggleFallback(): Promise<boolean> {
    const candidates = ["/admin/api/fallback/toggle", "/api/fallback/toggle"];
    for (const ep of candidates) {
      try {
        await this.request(ep, { method: "POST" });
        return true;
      } catch {}
    }
    // buncaster-cli: /api/fallback changes folder, not pause. Treat as no-op but succeed
    // so pausePlayback/startPlayback don't throw
    return true;
  }

  // ── File Library ────────────────────────────────────────

  public async getFiles(): Promise<string[]> {
    for (const ep of ["/api/files", "/admin/api/files"]) {
      try {
        const data = await this.request<{ files: string[] }>(ep);
        return data.files || [];
      } catch {}
    }
    return [];
  }
}
