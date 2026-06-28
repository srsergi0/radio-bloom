import { createConnection, Socket } from "node:net";

export class TelnetClient {
  private socket: Socket | null = null;
  private connected = false;
  private isConnecting = false;
  private commandQueue: {
    cmd: string;
    resolve: (val: string[]) => void;
    reject: (err: Error) => void;
    timeoutMs: number;
  }[] = [];
  private currentCommand: {
    resolve: (val: string[]) => void;
    reject: (err: Error) => void;
    lines: string[];
    buf: string;
    timer: Timer;
  } | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly reconnectIntervalMs = 2000
  ) {
    this.connect();
  }

  private connect() {
    if (this.isConnecting || this.connected) return;
    this.isConnecting = true;

    console.log(`[TelnetClient] Connecting to Liquidsoap telnet at ${this.host}:${this.port}...`);
    this.socket = createConnection(this.port, this.host);

    this.socket.on("connect", () => {
      this.connected = true;
      this.isConnecting = false;
      console.log(`[TelnetClient] Connected to Liquidsoap telnet.`);
      this.processQueue();
    });

    this.socket.on("data", (data) => {
      if (!this.currentCommand) return;
      this.currentCommand.buf += data.toString();
      while (this.currentCommand.buf.includes("\n")) {
        const idx = this.currentCommand.buf.indexOf("\n");
        const line = this.currentCommand.buf.substring(0, idx).trim();
        this.currentCommand.buf = this.currentCommand.buf.substring(idx + 1);

        if (line === "END") {
          const { resolve, timer, lines } = this.currentCommand;
          clearTimeout(timer);
          this.currentCommand = null;
          resolve(lines);
          this.processQueue();
          return;
        }

        if (line !== "") {
          this.currentCommand.lines.push(line);
        }
      }
    });

    this.socket.on("error", (err) => {
      console.error(`[TelnetClient] Socket error:`, err.message);
      this.handleDisconnect(err);
    });

    this.socket.on("close", () => {
      console.log(`[TelnetClient] Socket connection closed.`);
      this.handleDisconnect(new Error("Connection closed"));
    });
  }

  private handleDisconnect(err: Error) {
    this.connected = false;
    this.isConnecting = false;
    this.socket = null;

    if (this.currentCommand) {
      clearTimeout(this.currentCommand.timer);
      this.currentCommand.reject(err);
      this.currentCommand = null;
    }

    // Reject all pending commands in the queue
    const queue = [...this.commandQueue];
    this.commandQueue = [];
    for (const item of queue) {
      item.reject(err);
    }

    setTimeout(() => this.connect(), this.reconnectIntervalMs);
  }

  private processQueue() {
    if (!this.connected || this.currentCommand || this.commandQueue.length === 0) return;
    const next = this.commandQueue.shift()!;

    const timer = setTimeout(() => {
      if (this.currentCommand) {
        const { reject } = this.currentCommand;
        this.currentCommand = null;
        reject(new Error("Command timeout"));
        this.socket?.destroy(); // Force disconnect to reset socket state
      }
    }, next.timeoutMs);

    this.currentCommand = {
      resolve: next.resolve,
      reject: next.reject,
      lines: [],
      buf: "",
      timer,
    };

    this.socket?.write(`${next.cmd}\n`);
  }

  public send(cmd: string, timeoutMs = 10000): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ cmd, resolve, reject, timeoutMs });
      this.processQueue();
    });
  }

  public isConnected(): boolean {
    return this.connected;
  }
}
