import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

function formatTime(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Build asset:// URL from absolute file path
function toAssetUrl(absolutePath: string): string {
  if (absolutePath.startsWith("asset://") || absolutePath.startsWith("http")) {
    return absolutePath;
  }
  return `asset://localhost/${absolutePath}`;
}

export default function PlayerWindow() {
  // Dual video elements for seamless switching
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const activeSlotRef = useRef<"A" | "B">("A");

  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number>(0);

  const [showUI, setShowUI] = useState(false);
  const [defaultVideo, setDefaultVideo] = useState("");
  const [isPlaying, setIsPlaying] = useState(true);
  const [isLooping, setIsLooping] = useState(true);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentVideoPath, setCurrentVideoPath] = useState("");

  const getActiveVideo = useCallback((): HTMLVideoElement | null => {
    return activeSlotRef.current === "A" ? videoARef.current : videoBRef.current;
  }, []);

  const getBackVideo = useCallback((): HTMLVideoElement | null => {
    return activeSlotRef.current === "A" ? videoBRef.current : videoARef.current;
  }, []);

  const resolveVideo = useCallback(async (path: string): Promise<string> => {
    try {
      return await invoke<string>("resolve_video_path", { path });
    } catch {
      console.warn("Could not resolve video path:", path);
      return path;
    }
  }, []);

  // Switch to a new video seamlessly using the back buffer
  const switchVideo = useCallback(
    (resolvedPath: string, shouldLoop: boolean) => {
      const back = getBackVideo();
      const front = getActiveVideo();
      if (!back) return;

      const src = toAssetUrl(resolvedPath);
      back.src = src;
      back.loop = shouldLoop;
      back.volume = front?.volume ?? volume;
      back.currentTime = 0;

      // Wait until back buffer has enough data to play
      const onCanPlay = () => {
        back.removeEventListener("canplay", onCanPlay);
        // Swap: bring back to front
        back.style.zIndex = "2";
        back.style.visibility = "visible";
        back.play().catch(() => {});

        // Hide old front
        if (front) {
          front.style.zIndex = "1";
          front.pause();
          front.removeAttribute("src");
          front.load(); // release memory
          front.style.visibility = "hidden";
        }

        // Flip active slot
        activeSlotRef.current = activeSlotRef.current === "A" ? "B" : "A";
        setCurrentVideoPath(resolvedPath);
        setIsLooping(shouldLoop);
        setIsPlaying(true);
      };

      back.addEventListener("canplay", onCanPlay);
      back.load();
    },
    [getActiveVideo, getBackVideo, volume]
  );

  // Report state to controller
  const reportStateRef = useRef<() => void>(() => {});
  reportStateRef.current = () => {
    const video = getActiveVideo();
    invoke("update_player_state", {
      state: {
        currentVideo: currentVideoPath,
        isPlaying: video ? !video.paused : false,
        isLooping,
        volume: video ? video.volume : volume,
        currentTime: video ? video.currentTime : 0,
        duration: video && isFinite(video.duration) ? video.duration : 0,
      },
    }).catch(() => {});
  };

  // Load config on mount — play default video directly on slot A
  useEffect(() => {
    invoke<{ default_video: string }>("get_config").then(async (config) => {
      const resolved = await resolveVideo(config.default_video);
      setDefaultVideo(resolved);
      setCurrentVideoPath(resolved);
      setIsLooping(true);

      // Initial play on slot A directly (no seamless switch needed)
      const videoA = videoARef.current;
      if (videoA) {
        videoA.src = toAssetUrl(resolved);
        videoA.loop = true;
        videoA.style.zIndex = "2";
        videoA.style.visibility = "visible";
        videoA.play().catch(() => {});
      }
    });
  }, [resolveVideo]);

  // Listen for play-video events
  useEffect(() => {
    const unlisten = listen<{ video: string; loop: boolean }>(
      "play-video",
      async (event) => {
        const resolved = await resolveVideo(event.payload.video);
        switchVideo(resolved, event.payload.loop);
      }
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [resolveVideo, switchVideo]);

  // Listen for return-to-loop
  useEffect(() => {
    const unlisten = listen("return-to-loop", () => {
      if (defaultVideo) {
        switchVideo(defaultVideo, true);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [defaultVideo, switchVideo]);

  // Listen for player-control commands from controller
  useEffect(() => {
    const unlisten = listen<{ action: string; value?: number }>(
      "player-control",
      (event) => {
        const video = getActiveVideo();
        if (!video) return;
        const { action, value } = event.payload;
        switch (action) {
          case "play":
            video.play();
            break;
          case "pause":
            video.pause();
            break;
          case "toggle":
            video.paused ? video.play() : video.pause();
            break;
          case "seek":
            if (value !== undefined) video.currentTime = value;
            break;
          case "volume":
            if (value !== undefined) {
              video.volume = value;
              setVolume(value);
            }
            break;
        }
      }
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, [getActiveVideo]);

  // Report state periodically
  useEffect(() => {
    const interval = setInterval(() => reportStateRef.current(), 500);
    return () => clearInterval(interval);
  }, []);

  // Mouse hover to show/hide UI
  const handleMouseMove = () => {
    setShowUI(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowUI(false), 3000);
  };

  const handleMouseLeave = () => {
    setShowUI(false);
    clearTimeout(hideTimerRef.current);
  };

  const handleTimeUpdate = () => {
    const video = getActiveVideo();
    if (!video) return;
    setCurrentTime(video.currentTime);
    setDuration(isFinite(video.duration) ? video.duration : 0);
    setIsPlaying(!video.paused);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const video = getActiveVideo();
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    video.currentTime = ratio * duration;
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    const video = getActiveVideo();
    if (video) video.volume = v;
  };

  const togglePlay = () => {
    const video = getActiveVideo();
    if (!video) return;
    video.paused ? video.play() : video.pause();
  };

  // When a non-loop video ends, seamlessly return to default loop
  const handleVideoEnded = (slot: "A" | "B") => {
    // Only handle if this is the currently active slot
    if (slot !== activeSlotRef.current) return;
    if (!isLooping && defaultVideo) {
      switchVideo(defaultVideo, true);
    }
  };

  // Shared video element props for time tracking
  const activeVideoProps = (slot: "A" | "B") => ({
    onTimeUpdate: () => {
      if (slot === activeSlotRef.current) handleTimeUpdate();
    },
    onEnded: () => handleVideoEnded(slot),
    onPlay: () => {
      if (slot === activeSlotRef.current) setIsPlaying(true);
    },
    onPause: () => {
      if (slot === activeSlotRef.current) setIsPlaying(false);
    },
  });

  return (
    <div
      ref={containerRef}
      className={`player-container ${showUI ? "show-ui" : ""}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <video
        ref={videoARef}
        className="player-video"
        style={{ zIndex: 2, visibility: "visible" }}
        {...activeVideoProps("A")}
      />
      <video
        ref={videoBRef}
        className="player-video"
        style={{ zIndex: 1, visibility: "hidden" }}
        {...activeVideoProps("B")}
      />
      <div className="player-overlay">
        <div className="progress-bar" onClick={handleSeek}>
          <div
            className="progress-fill"
            style={{ width: duration ? `${(currentTime / duration) * 100}%` : "0%" }}
          />
        </div>
        <div className="controls-row">
          <button className="control-btn" onClick={togglePlay}>
            {isPlaying ? "||" : ">"}
          </button>
          <span className="time-display">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <input
            type="range"
            className="volume-slider"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolumeChange}
          />
          <span className="now-playing">
            {isLooping ? "Loop" : "One-shot"}
          </span>
        </div>
      </div>
    </div>
  );
}
