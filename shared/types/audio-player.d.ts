declare global {
  type AudioEngine = "auto" | "mpv" | "chromium";
  type AudioOutputMode = "shared" | "direct";
  type NativeAudioBackend = "mpv" | "chromium";

  interface NativeAudioConfig {
    engine: AudioEngine;
    mpvPath?: string;
    outputMode: AudioOutputMode;
    audioDevice?: string;
  }

  interface NativeAudioFormat {
    sampleRate?: number;
    format?: string;
    channels?: string;
  }

  interface NativeAudioStatus {
    available: boolean;
    backend: NativeAudioBackend;
    /** Monotonic main-process revision used to discard delayed IPC events. */
    revision?: number;
    executable?: string;
    outputDriver?: string;
    audioDevice?: string;
    source?: NativeAudioFormat;
    output?: NativeAudioFormat;
    error?: string;
  }

  interface NativeAudioLoadRequest {
    url: string;
    position: number;
    paused: boolean;
  }

  interface NativeAudioProbeResult {
    devices: Array<{ description: string; name: string }>;
    status: NativeAudioStatus;
  }

  type NativeAudioEvent =
    | { type: "duration"; value: number }
    | { type: "time"; value: number }
    | { type: "play" }
    | { type: "pause" }
    | { type: "ended" }
    | { type: "rate"; value: number }
    | { type: "status"; value: NativeAudioStatus }
    | { type: "error"; message: string; recoverable: boolean };
}

export {};
