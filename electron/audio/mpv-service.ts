import type { ChildProcess } from "node:child_process";

import log from "electron-log";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findMpvExecutable } from "./mpv-discovery";
import { MpvTransport } from "./mpv-transport";

interface MpvEventMessage {
  data?: unknown;
  error?: string;
  event: string;
  name?: string;
  reason?: string;
}

interface FileLoadWaiter {
  reject: (reason: Error) => void;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

type NativeAudioEventListener = (event: NativeAudioEvent) => void;

const observedProperties = [
  "pause",
  "time-pos",
  "duration",
  "speed",
  "audio-params",
  "audio-out-params",
  "current-ao",
  "audio-device",
] as const;

const toAudioFormat = (value: unknown): NativeAudioFormat | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const params = value as Record<string, unknown>;
  return {
    sampleRate: typeof params.samplerate === "number" ? params.samplerate : undefined,
    format: typeof params.format === "string" ? params.format : undefined,
    channels:
      typeof params["hr-channels"] === "string"
        ? params["hr-channels"]
        : typeof params.channels === "string"
          ? params.channels
          : undefined,
  };
};

const outputDriver = (platform: NodeJS.Platform, mode: AudioOutputMode): string => {
  if (platform === "win32") return "wasapi";
  if (platform === "darwin") return "coreaudio";
  return mode === "direct" ? "alsa" : "pipewire,pulse,alsa";
};

export class MpvService {
  private configurationQueue: Promise<void> = Promise.resolve();
  private config?: NativeAudioConfig;
  private endpoint?: string;
  private executable?: string;
  private fileLoaded = false;
  private fileLoadWaiter?: FileLoadWaiter;
  private listener?: NativeAudioEventListener;
  private process?: ChildProcess;
  private runtimeDirectory?: string;
  private status: NativeAudioStatus = { available: false, backend: "chromium" };
  private transport?: MpvTransport;

  setEventListener(listener?: NativeAudioEventListener): void {
    this.listener = listener;
  }

  getStatus(): NativeAudioStatus {
    return structuredClone(this.status);
  }

  async configure(config: NativeAudioConfig): Promise<NativeAudioStatus> {
    const operation = this.configurationQueue.then(() => this.applyConfig(config));
    this.configurationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async applyConfig(config: NativeAudioConfig): Promise<NativeAudioStatus> {
    const changed = JSON.stringify(config) !== JSON.stringify(this.config);
    this.config = { ...config };

    if (config.engine === "chromium") {
      await this.stop();
      this.replaceStatus({ available: false, backend: "chromium" });
      return this.getStatus();
    }

    if (changed && this.process) await this.stop();
    return this.ensureStarted();
  }

  async load(request: NativeAudioLoadRequest, headers: Record<string, string> = {}): Promise<void> {
    await this.ensureStarted();
    const transport = this.requireTransport();
    const headerFields = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);

    this.cancelFileLoad(new Error("mpv load superseded by a newer request"));
    this.fileLoaded = false;
    this.updateStatus({ source: undefined, output: undefined });
    await transport.command(["set_property", "http-header-fields", headerFields]);
    await transport.command(["set_property", "pause", true]);
    const fileLoaded = this.waitForFileLoaded();
    try {
      await transport.command(["loadfile", request.url, "replace"]);
      await fileLoaded;
    } catch (error) {
      this.cancelFileLoad(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (request.position > 0) await transport.command(["set_property", "time-pos", request.position]);
    await transport.command(["set_property", "pause", request.paused]);
  }

  async play(): Promise<void> {
    await this.requireTransport().command(["set_property", "pause", false]);
  }

  async pause(): Promise<void> {
    await this.requireTransport().command(["set_property", "pause", true]);
  }

  async seek(position: number): Promise<void> {
    await this.requireTransport().command(["set_property", "time-pos", Math.max(0, position)]);
  }

  async setVolume(volume: number): Promise<void> {
    await this.requireTransport().command(["set_property", "volume", Math.max(0, Math.min(1, volume)) * 100]);
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.requireTransport().command(["set_property", "mute", muted]);
  }

  async setRate(rate: number): Promise<void> {
    await this.requireTransport().command(["set_property", "speed", rate]);
  }

  async setLoop(loop: boolean): Promise<void> {
    await this.requireTransport().command(["set_property", "loop-file", loop ? "inf" : "no"]);
  }

  async listDevices(): Promise<Array<{ description: string; name: string }>> {
    await this.ensureStarted();
    const devices = await this.requireTransport().command<unknown>(["get_property", "audio-device-list"]);
    if (!Array.isArray(devices)) return [];

    return devices.flatMap(device => {
      if (!device || typeof device !== "object") return [];
      const item = device as Record<string, unknown>;
      if (typeof item.name !== "string") return [];
      return [{ name: item.name, description: typeof item.description === "string" ? item.description : item.name }];
    });
  }

  async stop(): Promise<void> {
    this.cancelFileLoad(new Error("mpv stopped"));
    this.fileLoaded = false;
    const process = this.process;
    this.process = undefined;
    this.transport?.close();
    this.transport = undefined;

    if (process && process.exitCode === null) {
      process.kill("SIGTERM");
    }

    if (this.runtimeDirectory) {
      await rm(this.runtimeDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    this.runtimeDirectory = undefined;
    this.endpoint = undefined;
    this.executable = undefined;
  }

  private async ensureStarted(): Promise<NativeAudioStatus> {
    if (this.transport && this.process?.exitCode === null) return this.getStatus();

    const config = this.config ?? { engine: "auto", outputMode: "shared" };
    const executable = await findMpvExecutable({ configuredPath: config.mpvPath });
    if (!executable) {
      const error = "未找到 mpv 可执行文件";
      this.replaceStatus({ available: false, backend: "chromium", error });
      throw new Error(error);
    }

    const endpoint = await this.createEndpoint();
    const driver = outputDriver(process.platform, config.outputMode);
    const args = [
      "--idle=yes",
      "--no-terminal",
      "--no-video",
      "--audio-display=no",
      "--input-default-bindings=no",
      "--input-vo-keyboard=no",
      "--no-config",
      `--input-ipc-server=${endpoint}`,
      `--ao=${driver}`,
      "--audio-client-name=Biu",
      "--gapless-audio=yes",
      "--audio-resample-filter-size=32",
    ];

    if (config.audioDevice) args.push(`--audio-device=${config.audioDevice}`);
    if (config.outputMode === "direct") args.push("--audio-exclusive=yes");

    log.info("[audio] Starting mpv native backend", { executable, driver, mode: config.outputMode });
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    this.process = child;
    this.executable = executable;
    this.endpoint = endpoint;

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.once("error", error => this.handleProcessFailure(error.message));
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      const detail = stderr.trim().split("\n").slice(-3).join(" | ");
      this.handleProcessFailure(`mpv exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`);
    });

    let transport: MpvTransport;
    try {
      transport = await this.connect(endpoint, child);
      this.transport = transport;
      transport.on("event", message => this.handleEvent(message as MpvEventMessage));
      transport.on("protocol-error", error => log.warn("[audio] mpv IPC protocol error", error));
      transport.once("close", () => {
        if (this.transport === transport && this.process === child) {
          this.handleProcessFailure("mpv IPC connection closed");
        }
      });

      for (const [id, property] of observedProperties.entries()) {
        await transport.command(["observe_property", id + 1, property]);
      }
    } catch (error) {
      await this.stop();
      const message = error instanceof Error ? error.message : String(error);
      this.replaceStatus({ available: false, backend: "chromium", error: message });
      throw error;
    }

    this.updateStatus({
      available: true,
      backend: "mpv",
      executable,
      outputDriver: driver,
      audioDevice: config.audioDevice,
    });
    return this.getStatus();
  }

  private async connect(endpoint: string, child: ChildProcess): Promise<MpvTransport> {
    const deadline = Date.now() + 5000;
    let lastError: unknown;

    while (Date.now() < deadline && child.exitCode === null) {
      const transport = new MpvTransport();
      try {
        await transport.connect(endpoint, 500);
        return transport;
      } catch (error) {
        lastError = error;
        transport.close();
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    child.kill("SIGTERM");
    throw lastError instanceof Error ? lastError : new Error("Unable to connect to mpv IPC");
  }

  private async createEndpoint(): Promise<string> {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (process.platform === "win32") return `\\\\.\\pipe\\biu-mpv-${suffix}`;

    const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
    const directory = await mkdtemp(path.join(base, "biu-mpv-"));
    await chmod(directory, 0o700);
    this.runtimeDirectory = directory;
    return path.join(directory, "ipc.sock");
  }

  private handleEvent(message: MpvEventMessage): void {
    if (message.event === "file-loaded") {
      this.fileLoaded = true;
      this.resolveFileLoad();
      return;
    }

    if (message.event === "end-file") {
      if (!this.fileLoaded) {
        this.cancelFileLoad(new Error(message.error || `mpv failed to load media: ${message.reason}`));
      }
      if (message.reason === "eof") this.listener?.({ type: "ended" });
      if (message.reason === "error") {
        this.listener?.({ type: "error", message: message.error || "mpv playback failed", recoverable: true });
      }
      return;
    }

    if (message.event !== "property-change" || !message.name) return;
    switch (message.name) {
      case "pause":
        if (this.fileLoaded) this.listener?.({ type: message.data ? "pause" : "play" });
        break;
      case "time-pos":
        if (this.fileLoaded && typeof message.data === "number") this.listener?.({ type: "time", value: message.data });
        break;
      case "duration":
        if (this.fileLoaded && typeof message.data === "number") {
          this.listener?.({ type: "duration", value: message.data });
        }
        break;
      case "speed":
        if (typeof message.data === "number") this.listener?.({ type: "rate", value: message.data });
        break;
      case "audio-params":
        this.updateStatus({ source: toAudioFormat(message.data) });
        break;
      case "audio-out-params":
        this.updateStatus({ output: toAudioFormat(message.data) });
        break;
      case "current-ao":
        if (typeof message.data === "string") this.updateStatus({ outputDriver: message.data });
        break;
      case "audio-device":
        if (typeof message.data === "string") this.updateStatus({ audioDevice: message.data });
        break;
    }
  }

  private handleProcessFailure(message: string): void {
    this.cancelFileLoad(new Error(message));
    this.fileLoaded = false;
    const child = this.process;
    this.process = undefined;
    this.transport?.close();
    this.transport = undefined;
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (this.runtimeDirectory) {
      void rm(this.runtimeDirectory, { force: true, recursive: true });
      this.runtimeDirectory = undefined;
    }
    this.endpoint = undefined;
    this.executable = undefined;
    this.replaceStatus({ available: false, backend: "chromium", error: message });
    this.listener?.({ type: "error", message, recoverable: true });
  }

  private requireTransport(): MpvTransport {
    if (!this.transport) throw new Error("mpv native backend is not running");
    return this.transport;
  }

  private updateStatus(patch: Partial<NativeAudioStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listener?.({ type: "status", value: this.getStatus() });
  }

  private replaceStatus(status: NativeAudioStatus): void {
    this.status = status;
    this.listener?.({ type: "status", value: this.getStatus() });
  }

  private waitForFileLoaded(timeoutMs = 15000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fileLoadWaiter = undefined;
        reject(new Error("Timed out waiting for mpv to load media"));
      }, timeoutMs);
      this.fileLoadWaiter = { reject, resolve, timer };
    });
  }

  private resolveFileLoad(): void {
    const waiter = this.fileLoadWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.fileLoadWaiter = undefined;
    waiter.resolve();
  }

  private cancelFileLoad(error: Error): void {
    const waiter = this.fileLoadWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.fileLoadWaiter = undefined;
    waiter.reject(error);
  }
}
