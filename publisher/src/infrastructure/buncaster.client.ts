const MAX_RECONNECT_ATTEMPTS = 100;

export interface BuncasterCurrentTrack {
  file: string;
  title: string;
  artist: string;
  duration: number;
  elapsed: number;
  isFallback: boolean;
  isLive: boolean;
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
  uptime: number;
  fallbackEnabled: boolean;
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
    private readonly reconnectIntervalMs = 2000
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
          `[BuncasterClient] Buncaster not ready (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}). Retrying in ${this.reconnectIntervalMs}ms...`
        );
        setTimeout(() => this.checkHealth(), this.reconnectIntervalMs);
      } else {
        console.error(
          `[BuncasterClient] Stopped reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts.`
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
    options: RequestInit = {}
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
        `Buncaster API error: ${res.status} ${res.statusText} - ${text}`
      );
    }

    return res.json() as Promise<T>;
  }

  // ── Stream ──────────────────────────────────────────────

  public getStreamUrl(): string {
    return `${this.baseUrl}/stream`;
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

  public async getCurrentTrack(): Promise<BuncasterCurrentTrack | null> {
    try {
      const data = await this.request<{ current: BuncasterCurrentTrack | null }>(
        "/admin/api/current"
      );
      return data.current;
    } catch {
      return null;
    }
  }

  // ── Queue Management ────────────────────────────────────

  public async getQueue(): Promise<BuncasterQueueItem[]> {
    try {
      const data = await this.request<{ queue: BuncasterQueueItem[] }>(
        "/admin/api/queue"
      );
      return data.queue || [];
    } catch {
      return [];
    }
  }

  public async pushToQueue(file: string): Promise<boolean> {
    try {
      await this.request("/admin/api/queue/push", {
        method: "POST",
        body: JSON.stringify({ file }),
      });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] pushToQueue failed:", err.message);
      return false;
    }
  }

  public async removeFromQueue(index: number): Promise<boolean> {
    try {
      await this.request("/admin/api/queue/remove", {
        method: "POST",
        body: JSON.stringify({ index }),
      });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] removeFromQueue failed:", err.message);
      return false;
    }
  }

  public async clearQueue(): Promise<boolean> {
    try {
      await this.request("/admin/api/queue/clear", { method: "POST" });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] clearQueue failed:", err.message);
      return false;
    }
  }

  public async moveInQueue(from: number, to: number): Promise<boolean> {
    try {
      await this.request("/admin/api/queue/move", {
        method: "POST",
        body: JSON.stringify({ from, to }),
      });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] moveInQueue failed:", err.message);
      return false;
    }
  }

  // ── Playback Controls ───────────────────────────────────

  public async skip(): Promise<boolean> {
    try {
      await this.request("/admin/api/skip", { method: "POST" });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] skip failed:", err.message);
      return false;
    }
  }

  public async shufflePlaylist(): Promise<boolean> {
    try {
      await this.request("/admin/api/playlist/shuffle", { method: "POST" });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] shufflePlaylist failed:", err.message);
      return false;
    }
  }

  public async toggleFallback(): Promise<boolean> {
    try {
      await this.request("/admin/api/fallback/toggle", { method: "POST" });
      return true;
    } catch (err: any) {
      console.error("[BuncasterClient] toggleFallback failed:", err.message);
      return false;
    }
  }

  // ── File Library ────────────────────────────────────────

  public async getFiles(): Promise<string[]> {
    try {
      const data = await this.request<{ files: string[] }>("/admin/api/files");
      return data.files || [];
    } catch {
      return [];
    }
  }
}
