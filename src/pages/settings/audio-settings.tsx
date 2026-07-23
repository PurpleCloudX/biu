import React, { useEffect, useState } from "react";
import { Controller, useWatch } from "react-hook-form";
import type { Control, UseFormSetValue } from "react-hook-form";

import { Button, Input, Select, SelectItem } from "@heroui/react";

const formatAudio = (format?: NativeAudioFormat) => {
  if (!format) return "等待播放";
  return [format.sampleRate ? `${format.sampleRate / 1000} kHz` : undefined, format.format, format.channels]
    .filter(Boolean)
    .join(" / ");
};

interface AudioSettingsProps {
  control: Control<AppSettings>;
  setValue: UseFormSetValue<AppSettings>;
}

const AudioSettings = ({ control, setValue }: AudioSettingsProps) => {
  const [devices, setDevices] = useState<Array<{ description: string; name: string }>>([]);
  const [isTesting, setIsTesting] = useState(false);
  const [probeStatus, setProbeStatus] = useState<NativeAudioStatus>();
  const [status, setStatus] = useState<NativeAudioStatus>();
  const [audioEngine, mpvPath, audioOutputMode, audioDevice] = useWatch({
    control,
    name: ["audioEngine", "mpvPath", "audioOutputMode", "audioDevice"],
  });

  useEffect(() => {
    let receivedStatus = false;
    const refreshDevices = async (currentStatus: NativeAudioStatus) => {
      if (currentStatus.backend !== "mpv") {
        setDevices([]);
        return;
      }
      setDevices(await window.electron.listNativeAudioDevices());
    };
    const unsubscribe = window.electron.onNativeAudioEvent(event => {
      if (event.type !== "status") return;
      receivedStatus = true;
      setStatus(event.value);
      void refreshDevices(event.value);
    });

    void window.electron.getNativeAudioStatus().then(currentStatus => {
      // A status event can arrive before this initial IPC response. Do not let
      // that stale snapshot erase the formats received from the active track.
      if (!receivedStatus) setStatus(currentStatus);
      return refreshDevices(currentStatus);
    });
    return unsubscribe;
  }, []);

  const testBackend = async () => {
    setIsTesting(true);
    try {
      const result = await window.electron.probeNativeAudio({
        engine: audioEngine,
        mpvPath,
        outputMode: audioOutputMode,
        audioDevice,
      });
      // The probe uses a separate, idle mpv process. Its status must not
      // replace the active player's negotiated source/output format.
      setProbeStatus(result.status);
      setDevices(result.devices);
    } catch (error) {
      setProbeStatus({
        available: false,
        backend: "chromium",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="w-full space-y-6">
      <div className="flex w-full items-center justify-between">
        <div className="mr-6 space-y-1">
          <div className="text-medium font-medium">播放引擎</div>
          <div className="text-sm text-zinc-500">自动模式优先使用 mpv，失败时回退 Chromium</div>
        </div>
        <div className="w-[240px]">
          <Controller
            control={control}
            name="audioEngine"
            render={({ field }) => (
              <Select
                disallowEmptySelection
                aria-label="播放引擎"
                selectedKeys={new Set([field.value])}
                onSelectionChange={keys => field.onChange(Array.from(keys)[0] as AudioEngine)}
              >
                <SelectItem key="auto">自动</SelectItem>
                <SelectItem key="mpv">mpv</SelectItem>
                <SelectItem key="chromium">Chromium</SelectItem>
              </Select>
            )}
          />
        </div>
      </div>

      <div className="flex w-full items-center justify-between">
        <div className="mr-6 space-y-1">
          <div className="text-medium font-medium">输出模式</div>
          <div className="text-sm text-zinc-500">共享模式兼容系统混音；Linux 直通需选择真实 ALSA hw 设备</div>
        </div>
        <div className="w-[240px]">
          <Controller
            control={control}
            name="audioOutputMode"
            render={({ field }) => (
              <Select
                disallowEmptySelection
                aria-label="输出模式"
                isDisabled={audioEngine === "chromium"}
                selectedKeys={new Set([field.value])}
                onSelectionChange={keys => field.onChange(Array.from(keys)[0] as AudioOutputMode)}
              >
                <SelectItem key="shared">共享</SelectItem>
                <SelectItem key="direct">独占 / 直通</SelectItem>
              </Select>
            )}
          />
        </div>
      </div>

      <div className="flex w-full items-center justify-between">
        <div className="mr-6 space-y-1">
          <div className="text-medium font-medium">mpv 路径</div>
          <div className="text-sm text-zinc-500">留空时搜索 PATH 和平台标准安装位置</div>
        </div>
        <div className="flex w-[420px] items-center gap-1">
          <Controller
            control={control}
            name="mpvPath"
            render={({ field }) => <Input isReadOnly placeholder="自动检测" value={field.value ?? ""} />}
          />
          <Button
            variant="flat"
            onPress={async () => {
              const selected = await window.electron.selectFile();
              if (selected) setValue("mpvPath", selected, { shouldDirty: true, shouldTouch: true });
            }}
          >
            选择
          </Button>
          {mpvPath && (
            <Button variant="light" onPress={() => setValue("mpvPath", "", { shouldDirty: true })}>
              自动
            </Button>
          )}
        </div>
      </div>

      <div className="flex w-full items-center justify-between">
        <div className="mr-6 space-y-1">
          <div className="text-medium font-medium">输出设备</div>
          <div className="text-sm text-zinc-500">名称前缀标明 mpv 后端；共享模式建议保留系统默认</div>
        </div>
        <div className="w-[420px]">
          <Controller
            control={control}
            name="audioDevice"
            render={({ field }) => (
              <Select
                aria-label="输出设备"
                disallowEmptySelection
                isDisabled={audioEngine === "chromium" || devices.length === 0}
                selectedKeys={new Set([devices.some(device => device.name === field.value) ? field.value : "auto"])}
                onSelectionChange={keys => {
                  const value = Array.from(keys)[0] as string | undefined;
                  field.onChange(value === "auto" ? "" : (value ?? ""));
                }}
              >
                {devices.map(device => (
                  <SelectItem key={device.name}>{device.description}</SelectItem>
                ))}
              </Select>
            )}
          />
        </div>
      </div>

      <div className="flex w-full items-start justify-between gap-6">
        <div className="min-w-0 space-y-1 text-sm text-zinc-500">
          <div>后端：{status?.backend ?? "尚未检测"}</div>
          <div>输出：{status?.outputDriver ?? "-"}</div>
          <div>源格式：{formatAudio(status?.source)}</div>
          <div>mpv 输出格式：{formatAudio(status?.output)}</div>
          {probeStatus && (
            <div>检测：{probeStatus.backend === "mpv" ? "mpv 可用" : (probeStatus.error ?? "未检测到 mpv")}</div>
          )}
          {status?.backend === "mpv" && audioOutputMode === "shared" && (
            <div>共享模式下，系统音频服务仍可能进行最终重采样</div>
          )}
          {status?.backend === "mpv" && audioOutputMode === "direct" && window.electron.getPlatform() === "linux" && (
            <div>只有输出设备为 alsa/hw:* 时才视为硬件直通</div>
          )}
          {status?.error && <div className="text-danger">{status.error}</div>}
        </div>
        <Button isLoading={isTesting} variant="flat" onPress={testBackend}>
          检测音频后端
        </Button>
      </div>
    </div>
  );
};

export default AudioSettings;
