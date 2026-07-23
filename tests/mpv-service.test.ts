import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MpvService } from "../electron/audio/mpv-service";

const temporaryDirectories: string[] = [];
const services: MpvService[] = [];

const createFakeMpv = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biu-fake-mpv-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "mpv");
  const argumentsFile = path.join(directory, "arguments.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(args));
const endpoint = args.find(arg => arg.startsWith("--input-ipc-server=")).slice("--input-ipc-server=".length);
const properties = {
  "audio-device": "auto",
  "audio-device-list": [
    { name: "pipewire/auto", description: "PipeWire" },
    { name: "pipewire/auto", description: "PipeWire duplicate" },
    { name: "alsa/hw:0,0", description: "ALSA device" }
  ],
  "audio-out-params": { samplerate: 48000, format: "float", "hr-channels": "stereo" },
  "audio-params": { samplerate: 96000, format: "s32", "hr-channels": "stereo" },
  "current-ao": "pipewire"
};
const server = net.createServer(socket => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line);
      const data = request.command[0] === "get_property" ? properties[request.command[1]] ?? null : null;
      socket.write(JSON.stringify({ request_id: request.request_id, error: "success", data }) + "\\n");
      if (request.command[0] === "loadfile") {
        socket.write(JSON.stringify({ event: "file-loaded" }) + "\\n");
        socket.write(JSON.stringify({ event: "property-change", name: "duration", data: 240 }) + "\\n");
      }
      if (request.command[0] === "set_property" && request.command[1] === "pause") {
        socket.write(JSON.stringify({ event: "property-change", name: "pause", data: request.command[2] }) + "\\n");
      }
      newline = buffer.indexOf("\\n");
    }
  });
});
server.listen(endpoint);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return { argumentsFile, executable };
};

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })));
});

describe("MpvService", () => {
  test("starts mpv, controls playback, and reports negotiated formats", async () => {
    const { argumentsFile, executable } = await createFakeMpv();
    const listener = vi.fn();
    const service = new MpvService();
    services.push(service);
    service.setEventListener(listener);

    await expect(
      service.configure({ engine: "mpv", mpvPath: executable, outputMode: "shared" }),
    ).resolves.toMatchObject({ available: true, backend: "mpv", executable });
    await service.load({ url: "https://audio.test/hires.flac", position: 4, paused: true }, { Referer: "test" });
    await service.play();

    await vi.waitFor(() => expect(service.getStatus().output?.sampleRate).toBe(48000));
    expect(service.getStatus()).toMatchObject({
      source: { sampleRate: 96000, format: "s32", channels: "stereo" },
      output: { sampleRate: 48000, format: "float", channels: "stereo" },
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ type: "play" }));

    const args = JSON.parse(await readFile(argumentsFile, "utf8")) as string[];
    expect(args).toContain("--ao=pipewire,pulse,alsa");
    expect(args).toContain("--gapless-audio=weak");
    expect(args).toContain("--audio-resample-filter-size=32");
  });

  test("normalizes output devices and keeps the system default", async () => {
    const { executable } = await createFakeMpv();
    const service = new MpvService();
    services.push(service);

    await service.configure({ engine: "mpv", mpvPath: executable, outputMode: "shared" });

    await expect(service.listDevices()).resolves.toEqual([
      { name: "auto", description: "系统默认" },
      { name: "pipewire/auto", description: "PipeWire" },
      { name: "alsa/hw:0,0", description: "ALSA device" },
    ]);
  });

  test("falls back to the system default when the saved output device is gone", async () => {
    const { executable } = await createFakeMpv();
    const service = new MpvService();
    services.push(service);

    await expect(
      service.configure({ engine: "mpv", mpvPath: executable, outputMode: "shared", audioDevice: "alsa/hw:9,9" }),
    ).resolves.toMatchObject({ audioDevice: "auto", backend: "mpv" });
  });
});
