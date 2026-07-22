import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MpvTransport } from "../electron/audio/mpv-transport";

const cleanup: Array<() => Promise<void> | void> = [];

const createServer = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biu-mpv-transport-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\biu-mpv-test-${process.pid}-${Date.now()}`
      : path.join(directory, "ipc.sock");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  cleanup.push(
    () => new Promise<void>(resolve => server.close(() => resolve())),
    () => rm(directory, { force: true, recursive: true }),
  );
  return { endpoint, server };
};

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("MpvTransport", () => {
  test("matches command responses by request id", async () => {
    const { endpoint, server } = await createServer();
    server.on("connection", socket => {
      socket.setEncoding("utf8");
      socket.on("data", payload => {
        const request = JSON.parse(String(payload).trim());
        socket.write(`${JSON.stringify({ request_id: request.request_id, error: "success", data: 42 })}\n`);
      });
    });

    const transport = new MpvTransport();
    cleanup.push(() => transport.close());
    await transport.connect(endpoint);
    await expect(transport.command(["get_property", "volume"])).resolves.toBe(42);
  });

  test("parses fragmented event messages", async () => {
    const { endpoint, server } = await createServer();
    const listener = vi.fn();
    server.on("connection", socket => {
      socket.write('{"event":"property-');
      socket.write('change","name":"pause","data":false}\n');
    });

    const transport = new MpvTransport();
    cleanup.push(() => transport.close());
    transport.on("event", listener);
    await transport.connect(endpoint);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(listener.mock.calls[0][0]).toMatchObject({ event: "property-change", name: "pause", data: false });
  });

  test("rejects commands after the connection closes", async () => {
    const { endpoint, server } = await createServer();
    server.on("connection", socket => socket.destroy());

    const transport = new MpvTransport();
    cleanup.push(() => transport.close());
    const closed = new Promise<void>(resolve => transport.once("close", resolve));
    await transport.connect(endpoint);
    await closed;
    await expect(transport.command(["get_property", "pause"])).rejects.toThrow("not connected");
  });
});
