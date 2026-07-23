import { ipcMain, session } from "electron";

import type { IpcHandlerProps } from "./types";

import { MpvService } from "../audio/mpv-service";
import { channel } from "./channel";

const mpvService = new MpvService();

const getMediaHeaders = async (mediaUrl: string): Promise<Record<string, string>> => {
  const url = new URL(mediaUrl);
  const isBilibili = url.hostname === "bilibili.com" || url.hostname.endsWith(".bilibili.com");
  const isBilibiliCdn = url.hostname.endsWith(".bilivideo.com") || url.hostname.endsWith(".bilivideo.cn");
  if (!isBilibili && !isBilibiliCdn) return {};

  const cookies = await session.defaultSession.cookies.get({ domain: ".bilibili.com" });
  const headers: Record<string, string> = {
    Referer: "https://www.bilibili.com/",
    "User-Agent": session.defaultSession.getUserAgent(),
  };
  if (isBilibili && cookies.length > 0) {
    headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  }
  return headers;
};

export const registerAudioHandlers = ({ getMainWindow }: IpcHandlerProps) => {
  mpvService.setEventListener(event => {
    getMainWindow()?.webContents.send(channel.audio.event, event);
  });

  ipcMain.handle(channel.audio.configure, (_, config: NativeAudioConfig) => mpvService.configure(config));
  ipcMain.handle(channel.audio.probe, async (_, config: NativeAudioConfig): Promise<NativeAudioProbeResult> => {
    const probe = new MpvService();
    try {
      const status = await probe.configure(config);
      const devices = status.backend === "mpv" ? await probe.listDevices() : [];
      return { devices, status };
    } finally {
      await probe.stop();
    }
  });
  ipcMain.handle(channel.audio.load, async (_, request: NativeAudioLoadRequest) => {
    const headers = request.url.startsWith("http") ? await getMediaHeaders(request.url) : {};
    await mpvService.load(request, headers);
  });
  ipcMain.handle(channel.audio.play, () => mpvService.play());
  ipcMain.handle(channel.audio.pause, () => mpvService.pause());
  ipcMain.handle(channel.audio.seek, (_, position: number) => mpvService.seek(position));
  ipcMain.handle(channel.audio.setVolume, (_, volume: number) => mpvService.setVolume(volume));
  ipcMain.handle(channel.audio.setMuted, (_, muted: boolean) => mpvService.setMuted(muted));
  ipcMain.handle(channel.audio.setRate, (_, rate: number) => mpvService.setRate(rate));
  ipcMain.handle(channel.audio.setLoop, (_, loop: boolean) => mpvService.setLoop(loop));
  ipcMain.handle(channel.audio.getStatus, () => mpvService.getPlaybackStatus());
  ipcMain.handle(channel.audio.listDevices, () => mpvService.listDevices());
};

export const shutdownAudioBackend = () => mpvService.stop();
