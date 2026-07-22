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
      socket.write(JSON.stringify({ request_id: request.request_id, error: "success", data: null }) + "\\n");
      if (request.command[0] === "loadfile") {
        socket.write(JSON.stringify({ event: "file-loaded" }) + "\\n");
        socket.write(JSON.stringify({ event: "property-change", name: "duration", data: 240 }) + "\\n");
        socket.write(JSON.stringify({ event: "property-change", name: "audio-params", data: { samplerate: 96000, format: "s32", "hr-channels": "stereo" } }) + "\\n");
        socket.write(JSON.stringify({ event: "property-change", name: "audio-out-params", data: { samplerate: 48000, format: "float", "hr-channels": "stereo" } }) + "\\n");
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
    expect(args).toContain("--audio-resample-filter-size=32");
  });
});
