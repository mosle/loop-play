use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RawHotkeyEntry {
    #[serde(default)]
    key: String,
    label: String,
    video: String,
    #[serde(default, rename = "loop")]
    loop_playback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyEntry {
    #[serde(default)]
    pub key: String,
    pub label: String,
    pub video: String,
    #[serde(rename = "loop")]
    pub loop_playback: bool,
}

impl From<RawHotkeyEntry> for HotkeyEntry {
    fn from(raw: RawHotkeyEntry) -> Self {
        Self {
            key: raw.key,
            label: raw.label,
            video: raw.video,
            loop_playback: raw.loop_playback,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopAudioConfig {
    pub path: String,
    #[serde(default = "default_volume")]
    pub volume: f64,
}

fn default_volume() -> f64 {
    0.5
}

#[derive(Debug, Clone, Deserialize)]
struct RawAppConfig {
    default_video: String,
    #[serde(default)]
    loop_audio: Option<LoopAudioConfig>,
    hotkeys: Vec<RawHotkeyEntry>,
    #[serde(default)]
    return_hotkey: String,
    #[serde(default = "default_monitor")]
    fullscreen_monitor: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub default_video: String,
    pub loop_audio: Option<LoopAudioConfig>,
    pub hotkeys: Vec<HotkeyEntry>,
    pub return_hotkey: String,
    pub fullscreen_monitor: u32,
    pub config_dir: String,
}

impl AppConfig {
    fn from_raw(raw: RawAppConfig, config_dir: PathBuf) -> Self {
        Self {
            default_video: raw.default_video,
            loop_audio: raw.loop_audio,
            hotkeys: raw.hotkeys.into_iter().map(HotkeyEntry::from).collect(),
            return_hotkey: raw.return_hotkey,
            fullscreen_monitor: raw.fullscreen_monitor,
            config_dir: config_dir.to_string_lossy().to_string(),
        }
    }
}

fn default_monitor() -> u32 {
    1
}

// Stores the path to the user's chosen config file
struct ConfigPath(Mutex<Option<PathBuf>>);

fn history_file(app: &tauri::AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    data_dir.join("config_history.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConfigHistory {
    last: String,
    recent: Vec<String>,
}

fn load_history(app: &tauri::AppHandle) -> ConfigHistory {
    let file = history_file(app);
    if let Ok(content) = fs::read_to_string(&file) {
        if let Ok(h) = serde_json::from_str::<ConfigHistory>(&content) {
            return h;
        }
    }
    // Migrate from old format
    let old_file = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("last_config_path.txt");
    if let Ok(path_str) = fs::read_to_string(&old_file) {
        let path = path_str.trim().to_string();
        if !path.is_empty() {
            let _ = fs::remove_file(&old_file);
            let h = ConfigHistory {
                last: path.clone(),
                recent: vec![path],
            };
            save_history(app, &h);
            return h;
        }
    }
    ConfigHistory {
        last: String::new(),
        recent: Vec::new(),
    }
}

fn save_history(app: &tauri::AppHandle, history: &ConfigHistory) {
    let file = history_file(app);
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&file, serde_json::to_string_pretty(history).unwrap());
}

fn add_to_history(app: &tauri::AppHandle, path: &PathBuf) {
    let mut history = load_history(app);
    let path_str = path.to_string_lossy().to_string();
    history.last = path_str.clone();
    history.recent.retain(|p| p != &path_str);
    history.recent.insert(0, path_str);
    // Keep max 10 entries
    history.recent.truncate(10);
    save_history(app, &history);
}

fn load_saved_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let history = load_history(app);
    if history.last.is_empty() {
        return None;
    }
    let path = PathBuf::from(&history.last);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn load_config_from_path(path: &PathBuf) -> Result<AppConfig, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config from {:?}: {}", path, e))?;
    let raw: RawAppConfig =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    let config_dir = path.parent().unwrap_or(&PathBuf::from(".")).to_path_buf();
    Ok(AppConfig::from_raw(raw, config_dir))
}

fn try_load_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let state = app.state::<ConfigPath>();
    let guard = state.0.lock().unwrap();
    match guard.as_ref() {
        Some(path) => load_config_from_path(path),
        None => Err("No config loaded".to_string()),
    }
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    try_load_config(&app)
}

#[tauri::command]
fn has_config(app: tauri::AppHandle) -> bool {
    let state = app.state::<ConfigPath>();
    let guard = state.0.lock().unwrap();
    guard.is_some()
}

#[tauri::command]
fn set_config_path(app: tauri::AppHandle, path: String) -> Result<AppConfig, String> {
    let config_path = PathBuf::from(&path);
    if !config_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Validate it's a valid config
    let config = load_config_from_path(&config_path)?;

    // Save and remember
    let canonical = config_path
        .canonicalize()
        .unwrap_or(config_path.clone());
    add_to_history(&app, &canonical);

    {
        let state = app.state::<ConfigPath>();
        let mut guard = state.0.lock().unwrap();
        *guard = Some(canonical);
    }

    // Re-register hotkeys
    setup_global_shortcuts(&app);

    Ok(config)
}

#[tauri::command]
fn get_config_history(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let history = load_history(&app);
    history
        .recent
        .iter()
        .filter_map(|p| {
            let path = PathBuf::from(p);
            let exists = path.exists();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let dir = path
                .parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or_default();
            if exists {
                Some(serde_json::json!({
                    "path": p,
                    "name": name,
                    "dir": dir,
                    "exists": true,
                }))
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
fn clean_config_history(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut history = load_history(&app);
    history.recent.retain(|p| PathBuf::from(p).exists());
    if !history.recent.iter().any(|p| p == &history.last) {
        history.last = history.recent.first().cloned().unwrap_or_default();
    }
    save_history(&app, &history);
    get_config_history(app)
}

#[tauri::command]
fn resolve_video_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    // Resolve relative to config file's directory
    let config_dir = {
        let state = app.state::<ConfigPath>();
        let guard = state.0.lock().unwrap();
        guard
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    };

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Relative to config dir
    if let Some(dir) = &config_dir {
        candidates.push(dir.join(&path));
    }

    // 2. As absolute path
    candidates.push(PathBuf::from(&path));

    for candidate in &candidates {
        if candidate.exists() {
            return candidate
                .canonicalize()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| format!("Failed to resolve path: {}", e));
        }
    }
    Err(format!("Video not found: {} (tried {:?})", path, candidates))
}

#[tauri::command]
fn probe_media(app: tauri::AppHandle, path: String) -> serde_json::Value {
    let resolved = {
        let config_dir = {
            let state = app.state::<ConfigPath>();
            let guard = state.0.lock().unwrap();
            guard
                .as_ref()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        };
        let mut found = None;
        if let Some(dir) = &config_dir {
            let candidate = dir.join(&path);
            if candidate.exists() {
                found = candidate.canonicalize().ok();
            }
        }
        if found.is_none() {
            let candidate = PathBuf::from(&path);
            if candidate.exists() {
                found = candidate.canonicalize().ok();
            }
        }
        match found {
            Some(p) => p.to_string_lossy().to_string(),
            None => return serde_json::json!(null),
        }
    };

    // Find ffprobe — .app bundles have a restricted PATH
    let ffprobe = [
        "ffprobe",
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "/usr/bin/ffprobe",
    ]
    .iter()
    .find(|p| {
        std::process::Command::new(p)
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    });

    let ffprobe = match ffprobe {
        Some(p) => *p,
        None => return serde_json::json!(null),
    };

    let output = std::process::Command::new(ffprobe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            &resolved,
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let json_str = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<serde_json::Value>(&json_str) {
                Ok(data) => {
                    let mut result = serde_json::json!({});

                    // Extract video stream info
                    if let Some(streams) = data.get("streams").and_then(|s| s.as_array()) {
                        for stream in streams {
                            let codec_type = stream.get("codec_type").and_then(|c| c.as_str()).unwrap_or("");
                            if codec_type == "video" {
                                result["video_codec"] = stream.get("codec_name").cloned().unwrap_or(serde_json::json!(null));
                                result["width"] = stream.get("width").cloned().unwrap_or(serde_json::json!(null));
                                result["height"] = stream.get("height").cloned().unwrap_or(serde_json::json!(null));
                                // fps from r_frame_rate (e.g. "30/1" or "30000/1001")
                                if let Some(fps_str) = stream.get("r_frame_rate").and_then(|f| f.as_str()) {
                                    let parts: Vec<&str> = fps_str.split('/').collect();
                                    if parts.len() == 2 {
                                        if let (Ok(num), Ok(den)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                                            if den > 0.0 {
                                                result["fps"] = serde_json::json!((num / den * 100.0).round() / 100.0);
                                            }
                                        }
                                    }
                                }
                            } else if codec_type == "audio" {
                                result["audio_codec"] = stream.get("codec_name").cloned().unwrap_or(serde_json::json!(null));
                                result["sample_rate"] = stream.get("sample_rate").cloned().unwrap_or(serde_json::json!(null));
                                result["channels"] = stream.get("channels").cloned().unwrap_or(serde_json::json!(null));
                            }
                        }
                    }

                    // Duration and file size from format
                    if let Some(format) = data.get("format") {
                        if let Some(dur) = format.get("duration").and_then(|d| d.as_str()).and_then(|d| d.parse::<f64>().ok()) {
                            result["duration"] = serde_json::json!((dur * 100.0).round() / 100.0);
                        }
                        if let Some(size) = format.get("size").and_then(|s| s.as_str()).and_then(|s| s.parse::<u64>().ok()) {
                            result["file_size"] = serde_json::json!(size);
                        }
                    }

                    result
                }
                Err(_) => serde_json::json!(null),
            }
        }
        _ => serde_json::json!(null), // ffprobe not found or failed — silent
    }
}

// Send events only to the player window
#[tauri::command]
fn play_video(app: tauri::AppHandle, video: String, should_loop: bool) {
    if let Some(player) = app.get_webview_window("player") {
        let _ = player.emit("play-video", serde_json::json!({ "video": video, "loop": should_loop }));
    }
}

#[tauri::command]
fn return_to_loop(app: tauri::AppHandle) {
    if let Some(player) = app.get_webview_window("player") {
        let _ = player.emit("return-to-loop", ());
    }
}

#[tauri::command]
fn player_control(app: tauri::AppHandle, action: String, value: Option<f64>) {
    if let Some(player) = app.get_webview_window("player") {
        let _ = player.emit(
            "player-control",
            serde_json::json!({ "action": action, "value": value }),
        );
    }
}

// Send state updates only to the controller window
#[tauri::command]
fn update_player_state(app: tauri::AppHandle, state: serde_json::Value) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("player-state-update", state);
    }
}

#[tauri::command]
fn get_monitors(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let primary_name = primary.as_ref().and_then(|p| p.name().map(|n| n.to_string()));

    monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let name = m.name().unwrap_or(&format!("Monitor {}", i)).to_string();
            let is_primary = primary_name.as_deref() == Some(&name);
            let scale = m.scale_factor();
            let logical_w = m.size().width as f64 / scale;
            let logical_h = m.size().height as f64 / scale;
            serde_json::json!({
                "index": i,
                "name": name,
                "width": m.size().width,
                "height": m.size().height,
                "logicalWidth": logical_w as u32,
                "logicalHeight": logical_h as u32,
                "scaleFactor": scale,
                "x": m.position().x,
                "y": m.position().y,
                "isPrimary": is_primary,
            })
        })
        .collect()
}

#[tauri::command]
fn open_player_on_monitor(app: tauri::AppHandle, monitor_index: usize) -> Result<(), String> {
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor = monitors
        .get(monitor_index)
        .ok_or_else(|| format!("Monitor {} not found", monitor_index))?;

    let position = monitor.position();
    let scale = monitor.scale_factor();
    let logical_x = position.x as f64 / scale;
    let logical_y = position.y as f64 / scale;
    let logical_w = monitor.size().width as f64 / scale;
    let logical_h = monitor.size().height as f64 / scale;

    if let Some(existing) = app.get_webview_window("player") {
        let _ = existing.destroy();
    }

    let player =
        WebviewWindowBuilder::new(&app, "player", WebviewUrl::App("player.html".into()))
            .title("Loop Play - Player")
            .position(logical_x + 1.0, logical_y + 1.0)
            .inner_size(logical_w - 2.0, logical_h - 2.0)
            .decorations(false)
            .always_on_top(true)
            .build()
            .map_err(|e| format!("Failed to create player window: {}", e))?;

    let _ = player.set_fullscreen(true);

    Ok(())
}

#[tauri::command]
fn close_player(app: tauri::AppHandle) {
    if let Some(player) = app.get_webview_window("player") {
        let _ = player.destroy();
    }
}

#[tauri::command]
fn set_compact_mode(app: tauri::AppHandle, compact: bool) {
    if let Some(main) = app.get_webview_window("main") {
        if compact {
            let _ = main.set_maximizable(false);
            let _ = main.set_size(tauri::LogicalSize::new(360.0, 120.0));
        } else {
            let _ = main.set_maximizable(true);
            let _ = main.set_size(tauri::LogicalSize::new(480.0, 700.0));
        }
    }
}

fn setup_global_shortcuts(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Unregister all existing shortcuts first
    let _ = app.global_shortcut().unregister_all();

    let config = match try_load_config(app) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Skipping hotkey setup: {}", e);
            return;
        }
    };

    let app_handle = app.clone();
    let config_clone = config.clone();

    let shortcuts: Vec<String> = config
        .hotkeys
        .iter()
        .filter(|h| !h.key.is_empty())
        .map(|h| h.key.clone())
        .chain(
            if config.return_hotkey.is_empty() {
                None
            } else {
                Some(config.return_hotkey.clone())
            },
        )
        .collect();

    if shortcuts.is_empty() {
        return;
    }

    let shortcut_refs: Vec<&str> = shortcuts.iter().map(|s| s.as_str()).collect();

    let _ = app.global_shortcut().on_shortcuts(
        shortcut_refs,
        move |_app, shortcut, _event| {
            let shortcut_str = shortcut.to_string();

            if shortcut_str.eq_ignore_ascii_case(&config_clone.return_hotkey) {
                if let Some(player) = app_handle.get_webview_window("player") {
                    let _ = player.emit("return-to-loop", ());
                }
                return;
            }

            for entry in &config_clone.hotkeys {
                if shortcut_str.eq_ignore_ascii_case(&entry.key) {
                    if let Some(player) = app_handle.get_webview_window("player") {
                        let _ = player.emit(
                            "play-video",
                            serde_json::json!({
                                "video": entry.video,
                                "loop": entry.loop_playback,
                            }),
                        );
                    }
                    return;
                }
            }
        },
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(ConfigPath(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_config,
            has_config,
            set_config_path,
            get_config_history,
            clean_config_history,
            resolve_video_path,
            probe_media,
            play_video,
            return_to_loop,
            player_control,
            update_player_state,
            get_monitors,
            open_player_on_monitor,
            close_player,
            set_compact_mode,
        ])
        .setup(|app| {
            // Try to restore last used config
            if let Some(saved_path) = load_saved_config_path(app.handle()) {
                eprintln!("Restoring config from {:?}", saved_path);
                let state = app.state::<ConfigPath>();
                let mut guard = state.0.lock().unwrap();
                *guard = Some(saved_path);
                drop(guard);
                setup_global_shortcuts(app.handle());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
