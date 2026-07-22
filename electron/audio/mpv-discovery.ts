import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executableNames = (platform: NodeJS.Platform) => (platform === "win32" ? ["mpv.exe", "mpv.com"] : ["mpv"]);

const standardPaths = (platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] => {
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "mpv", "mpv.exe"),
      env.ProgramFiles && path.join(env.ProgramFiles, "mpv", "mpv.exe"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"]!, "mpv", "mpv.exe"),
      path.join(home, "scoop", "apps", "mpv", "current", "mpv.exe"),
    ].filter((candidate): candidate is string => Boolean(candidate));
  }

  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin/mpv",
      "/usr/local/bin/mpv",
      "/Applications/mpv.app/Contents/MacOS/mpv",
      path.join(home, ".local", "bin", "mpv"),
    ];
  }

  return [
    "/run/current-system/sw/bin/mpv",
    `/etc/profiles/per-user/${os.userInfo().username}/bin/mpv`,
    "/usr/local/bin/mpv",
    "/usr/bin/mpv",
    path.join(home, ".nix-profile", "bin", "mpv"),
    path.join(home, ".local", "bin", "mpv"),
  ];
};

const isExecutable = async (candidate: string, platform: NodeJS.Platform): Promise<boolean> => {
  try {
    await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface MpvDiscoveryOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export const findMpvExecutable = async ({
  configuredPath,
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
}: MpvDiscoveryOptions = {}): Promise<string | undefined> => {
  const candidates: string[] = [];

  if (configuredPath?.trim()) {
    candidates.push(path.resolve(configuredPath.trim()));
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames(platform)) {
      candidates.push(path.join(directory, name));
    }
  }

  candidates.push(...standardPaths(platform, home, env));

  for (const candidate of new Set(candidates)) {
    if (await isExecutable(candidate, platform)) return candidate;
  }

  return undefined;
};
