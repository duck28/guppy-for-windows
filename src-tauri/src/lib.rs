//! Guppy: downloads videos and audio with yt-dlp and converts files with FFmpeg. The interface (src/) holds the
//! queue; this backend finds and installs the tools and runs them.

mod convert;
mod tools;
mod ytdlp;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// How far a download or conversion is.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// 0...1, or None while it isn't known.
    pub fraction: Option<f64>,
    /// Bytes per second.
    pub speed: Option<f64>,
    /// Seconds left.
    pub eta: Option<f64>,
    /// "downloading", "processing" or "converting".
    pub stage: &'static str,
}

#[derive(Serialize, Clone)]
struct JobProgress {
    id: String,
    #[serde(flatten)]
    progress: Progress,
}

#[derive(Serialize, Clone)]
struct ToolProgress {
    tool: &'static str,
    fraction: f64,
}

struct AppState {
    tools: tokio::sync::Mutex<Option<tools::Tools>>,
    /// Cancellation flags of the running downloads and conversions, by job id.
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    async fn tools(&self) -> tools::Tools {
        let mut tools = self.tools.lock().await;
        if tools.is_none() {
            *tools = Some(tools::find().await);
        }
        tools.clone().unwrap()
    }

    async fn refresh_tools(&self) -> tools::Tools {
        let found = tools::find().await;
        *self.tools.lock().await = Some(found.clone());
        found
    }

    fn start_job(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.jobs.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }

    fn end_job(&self, id: &str) {
        self.jobs.lock().unwrap().remove(id);
    }
}

type Result<T> = std::result::Result<T, String>;

const NO_YTDLP: &str = "Guppy needs yt-dlp to download. Set it up in Settings.";
const NO_FFMPEG: &str = "Guppy needs FFmpeg to convert. Set it up in Settings.";

// MARK: - Tools

#[tauri::command]
async fn find_tools(state: State<'_, AppState>) -> Result<tools::Tools> {
    Ok(state.refresh_tools().await)
}

/// Downloads whatever is missing (and an outdated yt-dlp). Emits `tools-progress`.
#[tauri::command]
async fn install_tools(app: AppHandle, state: State<'_, AppState>) -> Result<tools::Tools> {
    let current = state.refresh_tools().await;
    if current.ytdlp.is_none() || current.ytdlp_outdated {
        let app = app.clone();
        tools::install_ytdlp(move |fraction| { let _ = app.emit("tools-progress", ToolProgress { tool: "yt-dlp", fraction }); }).await?;
    }
    if current.ffmpeg.is_none() {
        let app = app.clone();
        tools::install_ffmpeg(move |fraction| { let _ = app.emit("tools-progress", ToolProgress { tool: "FFmpeg", fraction }); }).await?;
    }
    Ok(state.refresh_tools().await)
}

/// Downloads the latest yt-dlp into Guppy's folder. Emits `tools-progress`.
#[tauri::command]
async fn update_ytdlp(app: AppHandle, state: State<'_, AppState>) -> Result<tools::Tools> {
    tools::install_ytdlp(move |fraction| { let _ = app.emit("tools-progress", ToolProgress { tool: "yt-dlp", fraction }); }).await?;
    Ok(state.refresh_tools().await)
}

// MARK: - Downloads and conversions

#[tauri::command]
async fn media_info(url: String, state: State<'_, AppState>) -> Result<ytdlp::MediaInfo> {
    let ytdlp = state.tools().await.ytdlp.ok_or(NO_YTDLP)?;
    ytdlp::info(&ytdlp, &url).await
}

/// Emits `job-progress`. Returns the saved file.
#[tauri::command]
async fn download(id: String, options: ytdlp::DownloadOptions, app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    let tools = state.tools().await;
    let ytdlp = tools.ytdlp.ok_or(NO_YTDLP)?;
    let ffmpeg = tools.ffmpeg.ok_or(NO_FFMPEG)?;
    let cancelled = state.start_job(&id);
    let job = id.clone();
    let result = ytdlp::download(&ytdlp, &ffmpeg, &options, cancelled, move |progress| {
        let _ = app.emit("job-progress", JobProgress { id: job.clone(), progress });
    }).await;
    state.end_job(&id);
    result
}

/// Emits `job-progress`. Returns the new file.
#[tauri::command]
async fn convert(id: String, options: convert::ConvertOptions, app: AppHandle, state: State<'_, AppState>) -> Result<String> {
    let ffmpeg = state.tools().await.ffmpeg.ok_or(NO_FFMPEG)?;
    let cancelled = state.start_job(&id);
    let job = id.clone();
    let result = convert::convert(&ffmpeg, &options, cancelled, move |progress| {
        let _ = app.emit("job-progress", JobProgress { id: job.clone(), progress });
    }).await;
    state.end_job(&id);
    result
}

#[tauri::command]
fn cancel_job(id: String, state: State<AppState>) {
    if let Some(flag) = state.jobs.lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn default_folder() -> String {
    dirs::download_dir().or_else(dirs::home_dir).unwrap_or_default().to_string_lossy().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState { tools: tokio::sync::Mutex::new(None), jobs: Mutex::new(HashMap::new()) })
        .on_window_event(|window, event| {
            // Stop yt-dlp and FFmpeg when the window goes away.
            if let tauri::WindowEvent::Destroyed = event {
                for flag in window.app_handle().state::<AppState>().jobs.lock().unwrap().values() {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            find_tools, install_tools, update_ytdlp, media_info, download, convert, cancel_job, default_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Guppy");
}
