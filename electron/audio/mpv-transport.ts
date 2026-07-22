import { EventEmitter } from "node:events";
import net from "node:net";

interface MpvResponse {
  data?: unknown;
  error?: string;
  event?: string;
  request_id?: number;
  [key: string]: unknown;
}

interface PendingRequest {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

export class MpvTransport extends EventEmitter {
  private buffer = "";
  private closeEmitted = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private socket?: net.Socket;

  async connect(endpoint: string, timeoutMs = 5000): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    this.closeEmitted = false;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to mpv IPC at ${endpoint}`));
      }, timeoutMs);

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("data", chunk => this.consume(String(chunk)));
      socket.on("close", () => this.handleClose());
    });
  }

  async command<T = unknown>(command: unknown[], timeoutMs = 5000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("mpv IPC is not connected");

    const requestId = this.nextRequestId++;
    const payload = `${JSON.stringify({ command, request_id: requestId })}\n`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`mpv command timed out: ${String(command[0])}`));
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      socket.write(payload, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.handleClose();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let message: MpvResponse;
    try {
      message = JSON.parse(line) as MpvResponse;
    } catch {
      this.emit("protocol-error", new Error("mpv returned invalid JSON"));
      return;
    }

    if (message.request_id !== undefined) {
      const request = this.pending.get(message.request_id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.request_id);

      if (message.error && message.error !== "success") {
        request.reject(new Error(`mpv command failed: ${message.error}`));
      } else {
        request.resolve(message.data);
      }
      return;
    }

    if (message.event) this.emit("event", message);
  }

  private handleClose(): void {
    const error = new Error("mpv IPC connection closed");
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!this.closeEmitted) {
      this.closeEmitted = true;
      this.emit("close");
    }
  }
}
