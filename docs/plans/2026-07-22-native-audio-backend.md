# Native Audio Backend Design

## Goals

- Prefer mpv's native audio outputs over Chromium audio playback.
- Use PipeWire first on Linux, WASAPI on Windows, and CoreAudio on macOS.
- Preserve Chromium playback as an automatic compatibility fallback.
- Keep the existing player behavior, media controls, mini player, lyrics, heartbeats, and spectrum view.
- Report both decoded source parameters and negotiated output parameters so conversions are visible.
- Default to shared system audio while offering an explicit exclusive/direct mode where the platform can support it.

## Non-goals

- Bundling mpv binaries in official Biu artifacts.
- Claiming bit-perfect output while using a shared PipeWire graph.
- Implementing a custom decoder or platform audio engine.
- Providing a zero-copy, single-decode spectrum path in the first version.

## Architecture

The renderer uses a backend-neutral player controller instead of directly treating an `HTMLAudioElement` as the player. Two implementations sit behind that controller:

- `NativeMpvBackend` delegates commands through Electron IPC to an mpv process managed by the main process.
- `ChromiumBackend` wraps the current `HTMLAudioElement` implementation and remains the compatibility fallback.

The Electron main process owns mpv discovery, process lifecycle, the local JSON IPC transport, platform output selection, and property observation. The renderer receives normalized player events and does not parse mpv messages directly.

The main process looks for mpv in this order:

1. A user-configured executable path.
2. `PATH`.
3. Standard platform-specific installation paths.

If discovery, startup, connection, or media loading fails, the controller restores the current URL, position, volume, mute state, and pause state in the Chromium backend.

## Platform Outputs

- Linux shared mode: `pipewire`, then `pulse`, then `alsa`.
- Linux direct mode: ALSA device access when explicitly selected and available.
- Windows shared mode: WASAPI shared mode.
- Windows direct mode: WASAPI exclusive mode.
- macOS shared mode: CoreAudio shared mode.
- macOS direct mode: CoreAudio exclusive access when supported by the selected device and mpv build.

Direct mode must never silently present shared output as bit-perfect. When exclusive access is unavailable, Biu reports the failure and either returns to shared mode or Chromium according to the selected engine policy.

## Format Negotiation

Biu does not force one global sample rate in shared mode. mpv decodes the selected source and asks the platform output for a compatible format. The platform backend performs conversion when the source format cannot be accepted.

Biu observes:

- `audio-params` for decoded source sample rate, sample format, and channel layout.
- `audio-out-params` for the format delivered by mpv's output path.
- the active audio output and device.

The settings UI compares these values and labels any rate, format, or channel-layout conversion. Native backend negotiation remains authoritative because mpv's JSON IPC does not expose a complete cross-platform matrix of every hardware-supported format.

## Playback State

The player controller normalizes load, play, pause, seek, volume, mute, duration, progress, buffering, end-of-file, and error events. Existing consumers such as lyrics, Media Session, the mini player, shortcuts, playback modes, and heartbeat reporting subscribe to normalized state rather than reading an audio element.

An mpv process is reused between tracks. Unexpected termination is restarted once. A second failure for the same operation triggers Chromium fallback and a non-blocking diagnostic notification instead of a restart loop.

## Spectrum

The spectrum is analysis-only and never feeds the native output path. While visible, it creates a muted Chromium media element for the same source, connects it to an `AnalyserNode`, and follows the native player's position. Drift is corrected only after crossing a threshold. Closing the spectrum stops and releases the analysis stream.

This retains the current visualization at the cost of one additional download and decode while the spectrum is visible. Authentication or format failures disable only the spectrum, not playback.

## Settings

- Playback engine: Auto, mpv, or Chromium.
- mpv executable: automatic discovery or explicit path.
- Output mode: Shared or Exclusive/Direct.
- Output device: system default or an mpv-reported device.
- Diagnostics: active backend, output driver, source parameters, output parameters, and conversion status.
- Backend test: validates executable, output driver, and device without replacing the current track.

Missing devices fall back to the system default. Invalid settings produce a non-blocking message and remain editable.

## Security

- mpv control uses a per-process local Unix socket or Windows named pipe, never a TCP listener.
- Socket paths are created in an application-owned runtime directory with restrictive permissions.
- Commands are serialized by a dedicated transport; renderer input is not concatenated into shell commands.
- mpv is spawned without a shell and receives URLs, headers, and options as argument-array or JSON IPC values.
- IPC connections and temporary socket files are removed on shutdown.

## Testing

- Unit tests cover executable discovery, backend selection, command serialization, event parsing, format comparison, and state restoration.
- Integration tests use a fake mpv process to cover startup, property observation, timeout, disconnect, one-shot restart, and Chromium fallback.
- Playback regressions cover play/pause, track changes, seek, volume, mute, playback modes, lyrics, Media Session, mini player, shortcuts, and heartbeat reporting.
- Linux hardware validation covers PipeWire shared playback, device hotplug, 44.1/48/96 kHz sources, and explicit ALSA direct mode.
- Windows and macOS implementations receive automated protocol coverage. Hardware behavior is documented as unverified until tested on those systems.
