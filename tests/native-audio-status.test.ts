import { describe, expect, test } from "vitest";

import { selectLatestNativeAudioStatus } from "@/audio/native-audio-status";

describe("selectLatestNativeAudioStatus", () => {
  test("keeps a newer playback snapshot when an older event arrives late", () => {
    const initial = { available: true, backend: "mpv" as const, revision: 4 };
    const activePlayback = {
      available: true,
      backend: "mpv" as const,
      revision: 5,
      source: { sampleRate: 96000, format: "s32", channels: "stereo" },
      output: { sampleRate: 96000, format: "s32", channels: "stereo" },
    };

    expect(selectLatestNativeAudioStatus(initial, activePlayback)).toEqual(activePlayback);
    expect(selectLatestNativeAudioStatus(activePlayback, initial)).toEqual(activePlayback);
  });

  test("accepts a newer status that clears formats while a new track loads", () => {
    const playing = {
      available: true,
      backend: "mpv" as const,
      revision: 9,
      source: { sampleRate: 96000, format: "s32", channels: "stereo" },
      output: { sampleRate: 96000, format: "s32", channels: "stereo" },
    };
    const loading = { available: true, backend: "mpv" as const, revision: 10, source: undefined, output: undefined };

    expect(selectLatestNativeAudioStatus(playing, loading)).toEqual(loading);
  });
});
