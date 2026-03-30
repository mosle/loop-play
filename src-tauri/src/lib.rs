use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
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

#[derive(Debug, Clone, Deserialize)]
struct RawAppConfig {
    default_video: String,
    hotkeys: Vec<RawHotkeyEntry>,
    #[serde(default)]
    return_hotkey: String,
    #[serde(default = "default_monitor")]
    fullscreen_monitor: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub default_video: String,
    pub hotkeys: Vec<HotkeyEntry>,
    pub return_hotkey: String,
    pub fullscreen_monitor: u32,
}

impl From<RawAppConfig> for AppConfig {
    fn from(raw: RawAppConfig) -> Self {
        Self {
            default_video: raw.default_video,
            hotkeys: raw.hotkeys.into_iter().map(HotkeyEntry::from).collect(),
            return_hotkey: raw.return_hotkey,
            fullscreen_monitor: raw.fullscreen_monitor,
        }
    }
}

fn default_monitor() -> u32 {
    1
}

fn get_config_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let config_path = resource_dir.join("config.json");
        if config_path.exists() {
            return config_path;
        }
    }
    let dev_path = PathBuf::from("../config.json");
    if dev_path.exists() {
        return dev_path;
    }
    let cwd_path = PathBuf::from("config.json");
    if cwd_path.exists() {
        return cwd_path;
    }
    PathBuf::from("config.json")
}

fn load_config(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = get_config_path(app);
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config from {:?}: {}", path, e))?;
    let raw: RawAppConfig =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    Ok(AppConfig::from(raw))
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    load_config(&app)
}

#[tauri::command]
fn resolve_video_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let candidates: Vec<PathBuf> = vec![
        app.path().resource_dir().ok().map(|d| d.join(&path)),
        Some(PathBuf::from("..").join(&path)),
        Some(PathBuf::from(&path)),
    ]
    .into_iter()
    .flatten()
    .collect();

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
    // Both position and size are in physical pixels — convert to logical
    let logical_x = position.x as f64 / scale;
    let logical_y = position.y as f64 / scale;
    let logical_w = monitor.size().width as f64 / scale;
    let logical_h = monitor.size().height as f64 / scale;

    eprintln!(
        "Opening player on monitor {} ({}): phys_pos=({},{}) logical_pos=({},{}) logical_size={}x{} scale={}",
        monitor_index,
        monitor.name().unwrap_or(&"unknown".to_string()),
        position.x, position.y,
        logical_x, logical_y,
        logical_w, logical_h, scale
    );

    // Close existing player window if any
    if let Some(existing) = app.get_webview_window("player") {
        let _ = existing.destroy();
    }

    // Create window positioned on the target monitor, then fullscreen
    let player =
        WebviewWindowBuilder::new(&app, "player", WebviewUrl::App("player.html".into()))
            .title("Loop Play - Player")
            .position(logical_x + 1.0, logical_y + 1.0)
            .inner_size(logical_w - 2.0, logical_h - 2.0)
            .decorations(false)
            .always_on_top(true)
            .build()
            .map_err(|e| format!("Failed to create player window: {}", e))?;

    // Fullscreen on whichever monitor the window is on
    let _ = player.set_fullscreen(true);

    Ok(())
}

#[tauri::command]
fn close_player(app: tauri::AppHandle) {
    if let Some(player) = app.get_webview_window("player") {
        let _ = player.destroy();
    }
}

fn setup_global_shortcuts(app: &tauri::AppHandle) {
    let config = match load_config(app) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to load config for shortcuts: {}", e);
            return;
        }
    };

    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let app_handle = app.clone();
    let config_clone = config.clone();

    let shortcuts: Vec<String> = config
        .hotkeys
        .iter()
        .filter(|h| !h.key.is_empty())
        .map(|h| h.key.clone())
        .chain(if config.return_hotkey.is_empty() { None } else { Some(config.return_hotkey.clone()) })
        .collect();

    if shortcuts.is_empty() {
        eprintln!("No hotkeys configured, skipping global shortcut registration");
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
        .invoke_handler(tauri::generate_handler![
            get_config,
            resolve_video_path,
            play_video,
            return_to_loop,
            player_control,
            update_player_state,
            get_monitors,
            open_player_on_monitor,
            close_player,
        ])
        .setup(|app| {
            // Dump all monitors at startup
            let monitors = app.available_monitors().unwrap_or_default();
            eprintln!("=== Available Monitors ({}) ===", monitors.len());
            for (i, m) in monitors.iter().enumerate() {
                eprintln!(
                    "  [{}] name={:?} pos=({},{}) size={}x{} scale={}",
                    i,
                    m.name().unwrap_or(&"?".to_string()),
                    m.position().x,
                    m.position().y,
                    m.size().width,
                    m.size().height,
                    m.scale_factor()
                );
            }
            let primary = app.primary_monitor().ok().flatten();
            if let Some(p) = &primary {
                eprintln!("  Primary: {:?}", p.name().unwrap_or(&"?".to_string()));
            }
            eprintln!("=============================");

            setup_global_shortcuts(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
