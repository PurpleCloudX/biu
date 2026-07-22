import log from "electron-log/renderer";

import { useSettings } from "@/store/settings";

export interface AudioPlayerLike {
  currentTime: number;
  duration: number;
  loop: boolean;
  muted: boolean;
  ondurationchange: (() => void) | null;
  onended: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onpause: (() => void) | null;
  onplay: (() => void) | null;
  onratechange: (() => void) | null;
  onseeked: (() => void) | null;
  ontimeupdate: (() => void) | null;
  paused: boolean;
  playbackRate: number;
  src: string;
  volume: number;
  load: () => void;
  pause: () => void;
  play: () => Promise<void>;
}

const createChromiumAudio = () => {
  const element = new Audio();
  element.preload = "metadata";
  element.controls = false;
  element.crossOrigin = "anonymous";
  return element;
};

export class AudioPlayer implements AudioPlayerLike {
  ondurationchange: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onpause: (() => void) | null = null;
  onplay: (() => void) | null = null;
  onratechange: (() => void) | null = null;
  onseeked: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;

  private activeBackend: NativeAudioBackend = "chromium";
  private readonly chromium = createChromiumAudio();
  private currentDuration = Number.NaN;
  private currentMuted = false;
  private currentPaused = true;
  private currentPosition = 0;
  private currentRate = 1;
  private currentSource = "";
  private currentVolume = 1;
  private desiredPaused = true;
  private loopEnabled = false;
  private preparedRevision = -1;
  private preparing?: Promise<boolean>;
  private preparingRevision = -1;
  private revision = 0;
  private retriedAfterCrash = false;

  constructor() {
    this.bindChromiumEvents();
    window.electron?.onNativeAudioEvent?.(event => this.handleNativeEvent(event));
  }

  get src(): string {
    return this.currentSource;
  }

  set src(value: string) {
    if (value === this.currentSource) return;
    this.currentSource = value;
    this.currentPosition = 0;
    this.currentDuration = Number.NaN;
    this.preparedRevision = -1;
    this.revision += 1;
    this.retriedAfterCrash = false;
  }

  get currentTime(): number {
    return this.activeBackend === "chromium" ? this.chromium.currentTime : this.currentPosition;
  }

  set currentTime(value: number) {
    const position = Math.max(0, Number.isFinite(value) ? value : 0);
    this.currentPosition = position;
    if (this.activeBackend === "chromium") {
      this.chromium.currentTime = position;
    } else if (this.preparedRevision === this.revision) {
      void window.electron.seekNativeAudio(position).catch(error => this.handleCommandError(error));
    }
  }

  get duration(): number {
    return this.activeBackend === "chromium" ? this.chromium.duration : this.currentDuration;
  }

  get paused(): boolean {
    return this.activeBackend === "chromium" ? this.chromium.paused : this.currentPaused;
  }

  get volume(): number {
    return this.currentVolume;
  }

  set volume(value: number) {
    this.currentVolume = Math.max(0, Math.min(1, value));
    this.chromium.volume = this.currentVolume;
    if (this.activeBackend === "mpv") {
      void window.electron.setNativeAudioVolume(this.currentVolume).catch(error => this.handleCommandError(error));
    }
  }

  get muted(): boolean {
    return this.currentMuted;
  }

  set muted(value: boolean) {
    this.currentMuted = value;
    this.chromium.muted = value;
    if (this.activeBackend === "mpv") {
      void window.electron.setNativeAudioMuted(value).catch(error => this.handleCommandError(error));
    }
  }

  get playbackRate(): number {
    return this.currentRate;
  }

  set playbackRate(value: number) {
    this.currentRate = value;
    this.chromium.playbackRate = value;
    if (this.activeBackend === "mpv") {
      void window.electron.setNativeAudioRate(value).catch(error => this.handleCommandError(error));
    }
  }

  get loop(): boolean {
    return this.loopEnabled;
  }

  set loop(value: boolean) {
    this.loopEnabled = value;
    this.chromium.loop = value;
    if (this.activeBackend === "mpv") {
      void window.electron.setNativeAudioLoop(value).catch(error => this.handleCommandError(error));
    }
  }

  load(): void {
    if (!this.currentSource) {
      this.stopAndClear();
      return;
    }
    if (!window.electron?.configureNativeAudio || useSettings.getState().audioEngine === "chromium") {
      this.activateChromium(this.revision);
      return;
    }
    void this.prepare(this.revision);
  }

  async play(): Promise<void> {
    if (!this.currentSource) throw new DOMException("No media source", "NotSupportedError");
    this.desiredPaused = false;
    if (this.activeBackend === "chromium" && this.preparedRevision === this.revision) {
      return this.playChromium();
    }
    const prepared = await this.ensurePrepared();
    if (prepared && this.activeBackend === "mpv") {
      await window.electron.playNativeAudio();
      return;
    }
    await this.playChromium();
  }

  pause(): void {
    this.desiredPaused = true;
    if (this.activeBackend === "mpv") {
      void window.electron.pauseNativeAudio().catch(error => this.handleCommandError(error));
      return;
    }
    this.chromium.pause();
  }

  async reconfigure(): Promise<void> {
    if (!this.currentSource) return;
    const shouldResume = !this.desiredPaused;
    this.currentPosition = this.currentTime;
    if (this.activeBackend === "mpv") {
      await window.electron.pauseNativeAudio().catch(error => this.handleCommandError(error));
    } else {
      this.chromium.pause();
    }
    this.revision += 1;
    this.preparedRevision = -1;
    await this.ensurePrepared();
    if (shouldResume) await this.play();
  }

  getAnalysisElement(): HTMLAudioElement {
    return this.chromium;
  }

  isNative(): boolean {
    return this.activeBackend === "mpv";
  }

  private async ensurePrepared(): Promise<boolean> {
    while (this.preparedRevision !== this.revision) {
      const revision = this.revision;
      await this.prepare(revision);
      if (revision === this.revision) break;
    }
    return this.activeBackend === "mpv";
  }

  private prepare(revision: number): Promise<boolean> {
    if (this.preparing && this.preparingRevision === revision) return this.preparing;
    this.preparingRevision = revision;
    this.preparing = this.prepareRevision(revision).finally(() => {
      if (this.preparingRevision === revision) this.preparing = undefined;
    });
    return this.preparing;
  }

  private async prepareRevision(revision: number): Promise<boolean> {
    const settings = useSettings.getState();
    const nativeApi = window.electron?.configureNativeAudio;
    if (!nativeApi) {
      this.activateChromium(revision);
      return false;
    }

    if (settings.audioEngine === "chromium") {
      await nativeApi({
        engine: "chromium",
        mpvPath: settings.mpvPath,
        outputMode: settings.audioOutputMode,
        audioDevice: settings.audioDevice,
      });
      if (revision === this.revision) this.activateChromium(revision);
      return false;
    }

    try {
      const status = await nativeApi({
        engine: settings.audioEngine,
        mpvPath: settings.mpvPath,
        outputMode: settings.audioOutputMode,
        audioDevice: settings.audioDevice,
      });
      if (revision !== this.revision || status.backend !== "mpv") return false;

      this.activeBackend = "mpv";
      await window.electron.loadNativeAudio({
        url: this.currentSource,
        position: this.currentPosition,
        paused: true,
      });
      if (revision !== this.revision) return false;

      await Promise.all([
        window.electron.setNativeAudioVolume(this.currentVolume),
        window.electron.setNativeAudioMuted(this.currentMuted),
        window.electron.setNativeAudioRate(this.currentRate),
        window.electron.setNativeAudioLoop(this.loopEnabled),
      ]);
      this.currentPaused = true;
      this.preparedRevision = revision;
      return true;
    } catch (error) {
      log.warn("[audio] Native backend unavailable, falling back to Chromium", error);
      this.activateChromium(revision);
      return false;
    }
  }

  private activateChromium(revision: number): void {
    this.activeBackend = "chromium";
    this.chromium.src = this.currentSource;
    this.chromium.volume = this.currentVolume;
    this.chromium.muted = this.currentMuted;
    this.chromium.playbackRate = this.currentRate;
    this.chromium.loop = this.loopEnabled;
    if (this.currentPosition > 0) this.chromium.currentTime = this.currentPosition;
    this.chromium.load();
    this.preparedRevision = revision;
  }

  private async playChromium(): Promise<void> {
    if (this.chromium.src !== this.currentSource) this.activateChromium(this.revision);
    await this.chromium.play();
  }

  private stopAndClear(): void {
    this.currentPaused = true;
    this.desiredPaused = true;
    this.currentPosition = 0;
    this.currentDuration = Number.NaN;
    this.chromium.pause();
    this.chromium.src = "";
    this.chromium.load();
    if (this.activeBackend === "mpv") {
      void window.electron.pauseNativeAudio().catch(() => undefined);
    }
    this.activeBackend = "chromium";
    this.preparedRevision = this.revision;
  }

  private bindChromiumEvents(): void {
    this.chromium.ondurationchange = () => {
      if (this.activeBackend !== "chromium") return;
      this.currentDuration = this.chromium.duration;
      this.ondurationchange?.();
    };
    this.chromium.ontimeupdate = () => {
      if (this.activeBackend !== "chromium") return;
      this.currentPosition = this.chromium.currentTime;
      this.ontimeupdate?.();
    };
    this.chromium.onseeked = () => {
      if (this.activeBackend === "chromium") this.onseeked?.();
    };
    this.chromium.onratechange = () => {
      if (this.activeBackend === "chromium") this.onratechange?.();
    };
    this.chromium.onplay = () => {
      if (this.activeBackend !== "chromium") return;
      this.currentPaused = false;
      this.onplay?.();
    };
    this.chromium.onpause = () => {
      if (this.activeBackend !== "chromium") return;
      this.currentPaused = true;
      this.onpause?.();
    };
    this.chromium.onended = () => {
      if (this.activeBackend === "chromium") {
        this.desiredPaused = true;
        this.onended?.();
      }
    };
    this.chromium.onerror = event => {
      if (this.activeBackend === "chromium") this.onerror?.(event);
    };
  }

  private handleNativeEvent(event: NativeAudioEvent): void {
    if (this.activeBackend !== "mpv") return;
    switch (event.type) {
      case "duration":
        this.currentDuration = event.value;
        this.ondurationchange?.();
        break;
      case "time":
        this.currentPosition = event.value;
        this.ontimeupdate?.();
        break;
      case "play":
        this.currentPaused = false;
        this.onplay?.();
        break;
      case "pause":
        this.currentPaused = true;
        this.onpause?.();
        break;
      case "ended":
        this.desiredPaused = true;
        this.onended?.();
        break;
      case "rate":
        this.currentRate = event.value;
        this.onratechange?.();
        break;
      case "error":
        void this.recoverFromNativeFailure(event);
        break;
    }
  }

  private async recoverFromNativeFailure(event: Extract<NativeAudioEvent, { type: "error" }>): Promise<void> {
    const shouldResume = !this.desiredPaused;
    if (event.recoverable && !this.retriedAfterCrash) {
      this.retriedAfterCrash = true;
      this.preparedRevision = -1;
      try {
        if (await this.ensurePrepared()) {
          if (shouldResume) await window.electron.playNativeAudio();
          return;
        }
      } catch (error) {
        log.warn("[audio] Native backend restart failed", error);
      }
    }

    await window.electron
      .configureNativeAudio({
        engine: "chromium",
        mpvPath: useSettings.getState().mpvPath,
        outputMode: useSettings.getState().audioOutputMode,
        audioDevice: useSettings.getState().audioDevice,
      })
      .catch(error => log.warn("[audio] Failed to stop native backend during fallback", error));
    this.activateChromium(this.revision);
    if (shouldResume) await this.playChromium().catch(error => this.onerror?.(error));
    this.onerror?.(new Error(event.message));
  }

  private handleCommandError(error: unknown): void {
    log.warn("[audio] Native backend command failed", error);
  }
}
