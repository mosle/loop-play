import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, HotkeyEntry, PlayerState } from "./types";

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

export default function ControllerWindow() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState(0);
  const [playerState, setPlayerState] = useState<PlayerState>({
    currentVideo: "",
    isPlaying: false,
    isLooping: true,
    volume: 1,
    currentTime: 0,
    duration: 0,
  });
  const [activeVideo, setActiveVideo] = useState<string>("");
  const [playerOpen, setPlayerOpen] = useState(false);

  // Load config and monitors
  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((c) => {
        setConfig(c);
        setSelectedMonitor(c.fullscreen_monitor);
        setActiveVideo(c.default_video);
      })
      .catch((e) => console.error("Failed to load config:", e));
    invoke<MonitorInfo[]>("get_monitors")
      .then(setMonitors)
      .catch((e) => console.error("Failed to get monitors:", e));
  }, []);

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
      console.error("Failed to open player:", e);
    }
  }, [selectedMonitor]);

  const closePlayer = useCallback(async () => {
    try {
      await invoke("close_player");
      setPlayerOpen(false);
    } catch (e) {
      console.error("Failed to close player:", e);
    }
  }, []);

  const switchVideo = useCallback((video: string, shouldLoop: boolean) => {
    setActiveVideo(video);
    invoke("play_video", { video, shouldLoop }).catch((e) =>
      console.error("Failed to switch video:", e)
    );
  }, []);

  const returnToLoop = useCallback(() => {
    if (config) {
      setActiveVideo(config.default_video);
      invoke("return_to_loop").catch((e) =>
        console.error("Failed to return to loop:", e)
      );
    }
  }, [config]);

  const playerControl = useCallback((action: string, value?: number) => {
    invoke("player_control", { action, value: value ?? null }).catch((e) =>
      console.error("player_control failed:", e)
    );
  }, []);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!playerState.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    playerControl("seek", ratio * playerState.duration);
  };

  if (!config) {
    return (
      <div className="controller" style={{ justifyContent: "center", alignItems: "center" }}>
        Loading config...
      </div>
    );
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
            Default Loop
            {config.return_hotkey && <span className="hotkey-badge">{config.return_hotkey}</span>}
            <br />
            <small className="switch-filename">{config.default_video.split("/").pop()}</small>
          </button>
          {config.hotkeys.map((entry: HotkeyEntry) => (
            <button
              key={entry.key}
              className={`switch-btn ${activeVideo === entry.video ? "active" : ""}`}
              onClick={() => switchVideo(entry.video, entry.loop)}
            >
              {entry.label}
              {entry.key && <span className="hotkey-badge">{entry.key}</span>}
              <br />
              <small className="switch-filename">{entry.video.split("/").pop()}</small>
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
            <div className="volume-control">
              <span style={{ fontSize: 14 }}>Vol</span>
              <input
                type="range"
                className="volume-slider"
                min="0"
                max="1"
                step="0.01"
                value={playerState.volume}
                onChange={(e) => playerControl("volume", parseFloat(e.target.value))}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="status-bar">
        <span>
          <span className={`status-dot ${playerOpen ? "connected" : "disconnected"}`} />
          {playerOpen ? "Player active" : "Player not opened"}
        </span>
        <span>{playerState.isLooping ? "Loop" : "One-shot"}</span>
      </div>
    </div>
  );
}
