import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { findMpvExecutable } from "../electron/audio/mpv-discovery";

const temporaryDirectories: string[] = [];

const createExecutable = async (name = "mpv") => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "biu-mpv-discovery-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, name);
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return { directory, executable };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })));
});

describe("findMpvExecutable", () => {
  test("prefers an explicit executable", async () => {
    const { executable } = await createExecutable();
    await expect(findMpvExecutable({ configuredPath: executable, env: { PATH: "" }, platform: "linux" })).resolves.toBe(
      executable,
    );
  });

  test("searches PATH", async () => {
    const { directory, executable } = await createExecutable();
    await expect(findMpvExecutable({ env: { PATH: directory }, platform: "linux" })).resolves.toBe(executable);
  });

  test("returns undefined when no candidate is executable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "biu-no-mpv-"));
    temporaryDirectories.push(directory);
    await expect(
      findMpvExecutable({ env: { PATH: directory }, home: directory, platform: "darwin" }),
    ).resolves.toBeUndefined();
  });
});
