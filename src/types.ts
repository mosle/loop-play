export interface HotkeyEntry {
  key: string;
  label: string;
  video: string;
  loop: boolean;
}

export interface LoopAudioConfig {
  path: string;
  volume: number;
}

export interface AppConfig {
  default_video: string;
  loop_audio?: LoopAudioConfig;
  hotkeys: HotkeyEntry[];
  return_hotkey: string;
  fullscreen_monitor: number;
  config_dir: string;
}

export interface PlayerState {
  currentVideo: string;
  isPlaying: boolean;
  isLooping: boolean;
  masterVolume: number;
  volume: number;
  currentTime: number;
  duration: number;
  audioVolume: number;
}
