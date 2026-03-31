import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, HotkeyEntry, PlayerState } from "./types";
import { useToast, ToastContainer } from "./Toast";

function toAssetUrl(absolutePath: string): string {
  if (absolutePath.startsWith("asset://") || absolutePath.startsWith("http")) {
    return absolutePath;
  }
  return `asset://localhost/${absolutePath}`;
}

function extractThumbnail(videoPath: string, seekTime = 0.5): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = toAssetUrl(videoPath);

    video.addEventListener("loadeddata", () => {
      video.currentTime = Math.min(seekTime, video.duration * 0.1 || seekTime);
    });

    video.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        video.removeAttribute("src");
        video.load();
        resolve(dataUrl);
      } catch (e) {
        reject(e);
      }
    });

    video.addEventListener("error", () => {
      reject(new Error("Failed to load video for thumbnail"));
    });

    // Timeout fallback
    setTimeout(() => reject(new Error("Thumbnail extraction timeout")), 5000);
  });
}

interface MediaInfo {
  video_codec?: string;
  audio_codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  file_size?: number;
  sample_rate?: string;
  channels?: number;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function MediaBadge({ info, type = "video" }: { info?: MediaInfo; type?: "video" | "audio" }) {
  if (!info) return null;
  const parts: string[] = [];
  if (type === "video") {
    if (info.width && info.height) parts.push(`${info.width}x${info.height}`);
    if (info.duration) parts.push(formatDuration(info.duration));
    if (info.fps) parts.push(`${info.fps}fps`);
    if (info.video_codec) parts.push(info.video_codec);
    if (info.audio_codec) parts.push(info.audio_codec);
    if (info.file_size) parts.push(formatSize(info.file_size));
  } else {
    if (info.duration) parts.push(formatDuration(info.duration));
    if (info.audio_codec) parts.push(info.audio_codec);
    if (info.sample_rate) parts.push(`${info.sample_rate}Hz`);
    if (info.channels) parts.push(`${info.channels}ch`);
    if (info.file_size) parts.push(formatSize(info.file_size));
  }
  if (parts.length === 0) return null;
  return <span className="switch-meta">{parts.join(" · ")}</span>;
}

interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
  scaleFactor: number;
  x: number;
  y: number;
  isPrimary: boolean;
}

function formatTime(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface HistoryEntry {
  path: string;
  name: string;
  dir: string;
  exists: boolean;
}

function ConfigDropZone({ onConfigLoaded }: { onConfigLoaded: (config: AppConfig) => void }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Load history on mount
  useEffect(() => {
    invoke<HistoryEntry[]>("get_config_history").then(setHistory).catch(() => {});
  }, []);

  const selectFromHistory = async (path: string) => {
    setError("");
    try {
      const config = await invoke<AppConfig>("set_config_path", { path });
      onConfigLoaded(config);
    } catch (err) {
      setError(String(err));
      // Refresh history (removes invalid entries)
      invoke<HistoryEntry[]>("clean_config_history").then(setHistory).catch(() => {});
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setError("");

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    const path = (file as any).path || file.name;

    try {
      const config = await invoke<AppConfig>("set_config_path", { path });
      onConfigLoaded(config);
    } catch (err) {
      setError(String(err));
    }
  };

  // Listen for Tauri's file drop events
  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      const paths = event.payload.paths;
      if (paths.length === 0) return;
      setError("");
      try {
        const config = await invoke<AppConfig>("set_config_path", { path: paths[0] });
        onConfigLoaded(config);
      } catch (err) {
        setError(String(err));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [onConfigLoaded]);

  return (
    <div className="controller" style={{ justifyContent: "center", alignItems: "center", gap: 16 }}>
      <div
        className={`drop-zone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="drop-icon">&#x1F4C4;</div>
        <div className="drop-text">Drop config.json here</div>
        <div className="drop-hint">or drag any .json config file</div>
        {error && <div className="drop-error">{error}</div>}
      </div>
      {history.length > 0 && (
        <div className="history-section">
          <div className="section-title">Recent</div>
          {history.map((entry) => (
            <button
              key={entry.path}
              className="history-btn"
              onClick={() => selectFromHistory(entry.path)}
            >
              <span className="history-name">{entry.name}</span>
              <span className="history-dir">{entry.dir}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ControllerWindow() {
  const toast = useToast();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState(0);
  const [playerState, setPlayerState] = useState<PlayerState>({
    currentVideo: "",
    isPlaying: false,
    isLooping: true,
    masterVolume: 1,
    volume: 1,
    currentTime: 0,
    duration: 0,
    audioVolume: 0.5,
  });
  const [activeVideo, setActiveVideo] = useState<string>("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [mediaInfos, setMediaInfos] = useState<Record<string, MediaInfo>>({});

  // Check if config exists on mount
  useEffect(() => {
    invoke<boolean>("has_config").then((has) => {
      if (has) {
        invoke<AppConfig>("get_config")
          .then((c) => {
            setConfig(c);
            setConfigLoaded(true);
            setSelectedMonitor(c.fullscreen_monitor);
            setActiveVideo(c.default_video);
            generateThumbnails(c);
          })
          .catch(() => setConfigLoaded(false));
      } else {
        setConfigLoaded(false);
      }
    });
    invoke<MonitorInfo[]>("get_monitors")
      .then(setMonitors)
      .catch((e) => toast.show(`Failed to get monitors: ${e}`));
  }, []);

  // Generate thumbnails and probe media info for all videos in config
  const generateThumbnails = useCallback(async (c: AppConfig) => {
    const videos = [c.default_video, ...c.hotkeys.map((h) => h.video)];
    const allPaths = c.loop_audio
      ? [...videos, c.loop_audio.path]
      : videos;

    const thumbs: Record<string, string> = {};
    const infos: Record<string, MediaInfo> = {};

    for (const v of allPaths) {
      try {
        const resolved = await invoke<string>("resolve_video_path", { path: v });
        // Thumbnail only for videos
        if (videos.includes(v)) {
          try {
            thumbs[v] = await extractThumbnail(resolved);
          } catch { /* skip */ }
        }
        // Probe media info
        const info = await invoke<MediaInfo | null>("probe_media", { path: v });
        if (info) infos[v] = info;
      } catch { /* skip */ }
    }
    setThumbnails(thumbs);
    setMediaInfos(infos);
  }, []);

  const handleConfigLoaded = useCallback((c: AppConfig) => {
    setConfig(c);
    setConfigLoaded(true);
    setSelectedMonitor(c.fullscreen_monitor);
    setActiveVideo(c.default_video);
    invoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(() => {});
    generateThumbnails(c);
  }, [generateThumbnails]);

  // Listen for player state updates
  useEffect(() => {
    const unlisten = listen<PlayerState>("player-state-update", (event) => {
      setPlayerState(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const openPlayer = useCallback(async () => {
    try {
      await invoke("open_player_on_monitor", { monitorIndex: selectedMonitor });
      setPlayerOpen(true);
    } catch (e) {
      toast.show(`Failed to open player: ${e}`);
    }
  }, [selectedMonitor]);

  const closePlayer = useCallback(async () => {
    try {
      await invoke("close_player");
      setPlayerOpen(false);
    } catch (e) {
      toast.show(`Failed to close player: ${e}`);
    }
  }, []);

  const switchVideo = useCallback((video: string, shouldLoop: boolean) => {
    setActiveVideo(video);
    invoke("play_video", { video, shouldLoop }).catch((e) =>
      toast.show(`Failed to switch video: ${e}`)
    );
  }, []);

  const returnToLoop = useCallback(() => {
    if (config) {
      setActiveVideo(config.default_video);
      invoke("return_to_loop").catch((e) =>
        toast.show(`Failed to return to loop: ${e}`)
      );
    }
  }, [config]);

  const playerControl = useCallback((action: string, value?: number) => {
    invoke("player_control", { action, value: value ?? null }).catch((e) =>
      toast.show(`Player control failed: ${e}`)
    );
  }, []);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!playerState.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    playerControl("seek", ratio * playerState.duration);
  };

  const reloadConfig = useCallback(async () => {
    setConfig(null);
    setConfigLoaded(false);
  }, []);

  // Show drop zone if no config
  if (!configLoaded || !config) {
    return <ConfigDropZone onConfigLoaded={handleConfigLoaded} />;
  }

  return (
    <div className="controller">
      {/* Monitor Selection */}
      <div className="section">
        <div className="section-title">Output Monitor</div>
        <div className="monitor-row">
          {monitors.map((m) => {
            const isBuiltIn = /color lcd|built.?in|internal/i.test(m.name);
            const displayName = isBuiltIn ? "MacBook" : m.name;
            return (
              <button
                key={m.index}
                className={`monitor-btn ${m.index === selectedMonitor ? "active" : ""}`}
                onClick={() => setSelectedMonitor(m.index)}
              >
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {displayName}
                </span>
                <br />
                <small style={{ color: "#999" }}>
                  {m.logicalWidth}x{m.logicalHeight}
                  {m.scaleFactor > 1 ? ` @${m.scaleFactor}x` : ""}
                </small>
                <br />
                <small style={{ color: "#666", fontSize: 10 }}>
                  {m.isPrimary ? "Main" : ""} #{m.index}
                </small>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <button
            className="monitor-btn"
            style={{ flex: 1, background: "#0f3460" }}
            onClick={openPlayer}
          >
            {playerOpen ? "Reopen Player" : "Open Player"}
          </button>
          {playerOpen && (
            <button
              className="monitor-btn"
              style={{ flex: 0, minWidth: 80, background: "#6b1a1a" }}
              onClick={closePlayer}
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Switcher */}
      <div className="section">
        <div className="section-title">Switcher</div>
        <div className="switcher-grid">
          <button
            className={`switch-btn loop-btn ${activeVideo === config.default_video ? "active" : ""}`}
            onClick={returnToLoop}
          >
            <div className="switch-thumb-wrap">
              {thumbnails[config.default_video]
                ? <img className="switch-thumb" src={thumbnails[config.default_video]} alt="" />
                : <div className="switch-thumb switch-thumb-loading" />}
            </div>
            <div className="switch-info">
              <span>
                Default Loop
                {config.return_hotkey && <span className="hotkey-badge">{config.return_hotkey}</span>}
              </span>
              <small className="switch-filename">{config.default_video.split("/").pop()}</small>
              <MediaBadge info={mediaInfos[config.default_video]} />
              {config.loop_audio && (
                <small className="switch-audio">
                  Audio: {config.loop_audio.path.split("/").pop()}
                  {mediaInfos[config.loop_audio.path] && (
                    <> &middot; <MediaBadge info={mediaInfos[config.loop_audio.path]} type="audio" /></>
                  )}
                </small>
              )}
            </div>
          </button>
          {config.hotkeys.map((entry: HotkeyEntry, i: number) => (
            <button
              key={entry.key || `entry-${i}`}
              className={`switch-btn ${activeVideo === entry.video ? "active" : ""}`}
              onClick={() => switchVideo(entry.video, entry.loop)}
            >
              <div className="switch-thumb-wrap">
                {thumbnails[entry.video]
                  ? <img className="switch-thumb" src={thumbnails[entry.video]} alt="" />
                  : <div className="switch-thumb switch-thumb-loading" />}
              </div>
              <div className="switch-info">
                <span>
                  {entry.label}
                  {entry.key && <span className="hotkey-badge">{entry.key}</span>}
                </span>
                <small className="switch-filename">{entry.video.split("/").pop()}</small>
                <MediaBadge info={mediaInfos[entry.video]} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Player Controls */}
      <div className="section">
        <div className="section-title">Player</div>
        <div className="player-controls">
          <div className="progress-bar" onClick={handleSeek}>
            <div
              className="progress-fill"
              style={{
                width: playerState.duration
                  ? `${(playerState.currentTime / playerState.duration) * 100}%`
                  : "0%",
              }}
            />
          </div>
          <div className="controls-row">
            <button
              className="ctrl-btn"
              onClick={() => playerControl(playerState.isPlaying ? "pause" : "play")}
            >
              {playerState.isPlaying ? "||" : ">"}
            </button>
            <span className="time-display">
              {formatTime(playerState.currentTime)} / {formatTime(playerState.duration)}
            </span>
          </div>
          <div className="mixer-section">
            <div className="mixer-row">
              <span className="volume-label-ctrl">Master</span>
              <input
                type="range"
                className="volume-slider"
                min="0"
                max="1"
                step="0.01"
                value={playerState.masterVolume ?? 1}
                onChange={(e) => playerControl("master_volume", parseFloat(e.target.value))}
              />
              <span className="volume-value">{Math.round((playerState.masterVolume ?? 1) * 100)}%</span>
            </div>
            <div className="mixer-row">
              <span className="volume-label-ctrl">Video</span>
              <input
                type="range"
                className="volume-slider"
                min="0"
                max="1"
                step="0.01"
                value={playerState.volume}
                onChange={(e) => playerControl("volume", parseFloat(e.target.value))}
              />
              <span className="volume-value">{Math.round(playerState.volume * 100)}%</span>
            </div>
            {config.loop_audio && (
              <div className="mixer-row">
                <span className="volume-label-ctrl">Audio</span>
                <input
                  type="range"
                  className="volume-slider"
                  min="0"
                  max="1"
                  step="0.01"
                  value={playerState.audioVolume ?? 0.5}
                  onChange={(e) => playerControl("audio_volume", parseFloat(e.target.value))}
                />
                <span className="volume-value">{Math.round((playerState.audioVolume ?? 0.5) * 100)}%</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="status-bar">
        <span>
          <span className={`status-dot ${playerOpen ? "connected" : "disconnected"}`} />
          {playerOpen ? "Player active" : "Player not opened"}
        </span>
        <span
          style={{ cursor: "pointer", textDecoration: "underline" }}
          onClick={reloadConfig}
        >
          Change config
        </span>
      </div>
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </div>
  );
}
