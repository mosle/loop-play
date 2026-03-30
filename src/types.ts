export interface HotkeyEntry {
  key: string;
  label: string;
  video: string;
  loop: boolean;
}

export interface AppConfig {
  default_video: string;
  hotkeys: HotkeyEntry[];
  return_hotkey: string;
  fullscreen_monitor: number;
}

export interface PlayerState {
  currentVideo: string;
  isPlaying: boolean;
  isLooping: boolean;
  volume: number;
  currentTime: number;
  duration: number;
}
