# Loop Play

Desktop app for looping video playback with hotkey/switcher-based video switching.

## Features

- Default video loop playback
- Seamless video switching via switcher UI or global hotkeys
- Multi-monitor support (fullscreen output on secondary display)
- Controller UI for playback control

## Setup

```bash
pnpm install
pnpm tauri dev
```

## Config

Define video paths and hotkeys in `config.json`:

```json
{
  "default_video": "./videos/loop.mp4",
  "hotkeys": [
    { "key": "F1", "label": "Main", "video": "./videos/main.mp4", "loop": false }
  ],
  "return_hotkey": "Escape"
}
```

`key` and `return_hotkey` are optional (switcher buttons work without hotkeys).

## Stack

Tauri v2 / React / TypeScript / Rust
