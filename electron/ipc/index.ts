import type { IpcHandlerProps } from "./types";

import { registerAppHandlers } from "./app";
import { registerAudioHandlers } from "./audio";
import { registerCookieIpcHandlers } from "./cookie";
import { registerDialogHandlers } from "./dialog";
import { registerDownloadHandlers } from "./download";
import { registerFontHandlers } from "./font";
import { registerLocalMusicHandlers } from "./local-music";
import { registerLyricsHandlers } from "./lyrics";
import { registerShortcutHandlers } from "./shortcut";
import { registerStoreHandlers } from "./store";
import { registerWindowHandlers } from "./window";

export function registerIpcHandlers(props: IpcHandlerProps) {
  registerStoreHandlers();
  registerAudioHandlers(props);
  registerDialogHandlers();
  registerFontHandlers();
  registerDownloadHandlers(props);
  registerAppHandlers();
  registerCookieIpcHandlers();
  registerWindowHandlers(props);
  registerShortcutHandlers(props);
  registerLyricsHandlers();
  registerLocalMusicHandlers();
}
