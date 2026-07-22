import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AudioPlayer } from "@/audio/audio-player";
import { useSettings } from "@/store/settings";

let emitNativeEvent: ((event: NativeAudioEvent) => void) | undefined;

const createNativeApi = () => ({
  configureNativeAudio: vi.fn(async () => ({ available: true, backend: "mpv" as const, executable: "/bin/mpv" })),
  loadNativeAudio: vi.fn(async () => undefined),
  onNativeAudioEvent: vi.fn((listener: (event: NativeAudioEvent) => void) => {
    emitNativeEvent = listener;
    return () => undefined;
  }),
  pauseNativeAudio: vi.fn(async () => undefined),
  playNativeAudio: vi.fn(async () => undefined),
  seekNativeAudio: vi.fn(async () => undefined),
  setNativeAudioLoop: vi.fn(async () => undefined),
  setNativeAudioMuted: vi.fn(async () => undefined),
  setNativeAudioRate: vi.fn(async () => undefined),
  setNativeAudioVolume: vi.fn(async () => undefined),
});

beforeEach(() => {
  emitNativeEvent = undefined;
  (window as any).electron = { setStore: vi.fn(async () => undefined) };
  useSettings.setState({
    audioDevice: "",
    audioEngine: "auto",
    audioOutputMode: "shared",
    mpvPath: "",
  });
});

afterEach(() => {
  (window as any).electron = undefined;
});

describe("AudioPlayer", () => {
  test("uses mpv and reflects native events", async () => {
    const api = createNativeApi();
    (window as any).electron = api;
    const player = new AudioPlayer();
    const onPlay = vi.fn();
    const onTime = vi.fn();
    player.onplay = onPlay;
    player.ontimeupdate = onTime;
    player.volume = 0.7;
    player.src = "https://audio.test/track.flac";
    player.currentTime = 12;
    player.load();
    await player.play();

    expect(api.configureNativeAudio).toHaveBeenCalledWith({
      engine: "auto",
      mpvPath: "",
      outputMode: "shared",
      audioDevice: "",
    });
    expect(api.loadNativeAudio).toHaveBeenCalledWith({
      url: "https://audio.test/track.flac",
      position: 12,
      paused: true,
    });
    expect(api.playNativeAudio).toHaveBeenCalledOnce();

    emitNativeEvent?.({ type: "time", value: 18.5 });
    emitNativeEvent?.({ type: "play" });
    expect(player.currentTime).toBe(18.5);
    expect(player.paused).toBe(false);
    expect(onTime).toHaveBeenCalledOnce();
    expect(onPlay).toHaveBeenCalledOnce();
  });

  test("falls back to Chromium when mpv is unavailable", async () => {
    const api = createNativeApi();
    api.configureNativeAudio.mockRejectedValueOnce(new Error("mpv missing"));
    (window as any).electron = api;
    const player = new AudioPlayer();
    const onPlay = vi.fn();
    player.onplay = onPlay;
    player.src = "https://audio.test/fallback.mp3";
    player.load();
    await player.play();

    expect(player.isNative()).toBe(false);
    expect(player.paused).toBe(false);
    expect(onPlay).toHaveBeenCalledOnce();
  });
});
