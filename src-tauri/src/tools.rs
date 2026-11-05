//! Finds yt-dlp and FFmpeg on this PC, or downloads them into Guppy's own folder (%LOCALAPPDATA%\Guppy\bin),
//! and runs them.

use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// An installed yt-dlp or FFmpeg.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub path: String,
    /// yt-dlp: a release date such as "2026.10.21". FFmpeg: its build name.
    pub version: String,
    /// Downloaded by Guppy into its own folder.
    pub is_managed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub ytdlp: Option<Tool>,
    pub ffmpeg: Option<Tool>,
    /// YouTube regularly breaks older yt-dlp releases.
    pub ytdlp_outdated: bool,
    pub folder: String,
}

const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL: &str = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

pub fn tools_folder() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("Guppy").join("bin")
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// Folders in PATH that contain `name`.
pub fn in_path(name: &str) -> Vec<PathBuf> {
    let file = executable_name(name);
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|p| p.join(&file)).filter(|p| p.is_file()).collect())
        .unwrap_or_default()
}

/// Subfolders of `root` whose name starts with `prefix` (ignoring case).
fn subfolders(root: &Path, prefix: &str) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|entries| entries.flatten()
            .filter(|e| e.file_name().to_string_lossy().to_lowercase().starts_with(&prefix.to_lowercase()))
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect())
        .unwrap_or_default()
}

/// The existing files among `paths`, each once.
fn unique_files(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths.into_iter()
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

/// Guppy's own copy first, then where winget, Scoop, Chocolatey and pip put yt-dlp.
fn ytdlp_candidates() -> Vec<PathBuf> {
    let exe = executable_name("yt-dlp");
    let mut paths = vec![tools_folder().join(&exe)];
    paths.extend(in_path("yt-dlp"));
    if let Some(local) = env_path("LOCALAPPDATA") {
        let winget = local.join("Microsoft").join("WinGet");
        paths.push(winget.join("Links").join(&exe));
        paths.extend(subfolders(&winget.join("Packages"), "yt-dlp.yt-dlp").into_iter().map(|f| f.join(&exe)));
        // pip installs into a folder per Python version.
        paths.extend(subfolders(&local.join("Programs").join("Python"), "Python").into_iter()
            .map(|f| f.join("Scripts").join(&exe)));
    }
    if let Some(roaming) = env_path("APPDATA") {
        paths.extend(subfolders(&roaming.join("Python"), "Python").into_iter().map(|f| f.join("Scripts").join(&exe)));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("scoop").join("shims").join(&exe));
        paths.push(home.join(".local").join("bin").join(&exe));
    }
    paths.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin").join(&exe));
    unique_files(paths)
}

fn ffmpeg_candidates() -> Vec<PathBuf> {
    let exe = executable_name("ffmpeg");
    let mut paths = vec![tools_folder().join(&exe)];
    paths.extend(in_path("ffmpeg"));
    if let Some(local) = env_path("LOCALAPPDATA") {
        let winget = local.join("Microsoft").join("WinGet");
        paths.push(winget.join("Links").join(&exe));
        // winget unpacks FFmpeg one folder deeper: <package>\ffmpeg-<build>\bin\ffmpeg.exe
        for package in ["yt-dlp.FFmpeg", "Gyan.FFmpeg", "BtbN.FFmpeg"] {
            for folder in subfolders(&winget.join("Packages"), package) {
                paths.extend(subfolders(&folder, "").into_iter().map(|f| f.join("bin").join(&exe)));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("scoop").join("shims").join(&exe));
    }
    paths.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin").join(&exe));
    unique_files(paths)
}

fn is_managed(path: &Path) -> bool {
    path.starts_with(tools_folder())
}

fn is_outdated(version: &str) -> bool {
    let date = version.get(..10).unwrap_or("");
    let Ok(released) = chrono::NaiveDate::parse_from_str(date, "%Y.%m.%d") else { return false };
    (chrono::Local::now().date_naive() - released).num_days() > 90
}

/// The newest yt-dlp and the first working FFmpeg.
pub async fn find() -> Tools {
    let mut ytdlps = Vec::new();
    for path in ytdlp_candidates() {
        let Ok(output) = command(&path).arg("--version").output().await else { continue };
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !version.is_empty() {
            ytdlps.push(Tool { is_managed: is_managed(&path), path: path.to_string_lossy().to_string(), version });
        }
    }
    // Guppy's own copy wins a tie, since Guppy can update it.
    let ytdlp = ytdlps.into_iter().max_by(|a, b| (&a.version, a.is_managed).cmp(&(&b.version, b.is_managed)));

    let mut ffmpeg = None;
    for path in ffmpeg_candidates() {
        let Ok(output) = command(&path).arg("-version").output().await else { continue };
        if !output.status.success() { continue; }
        // "ffmpeg version N-127043-g5a54fcf75e-20251012 Copyright ..."
        let version = String::from_utf8_lossy(&output.stdout).split_whitespace().nth(2).unwrap_or("").to_string();
        ffmpeg = Some(Tool { is_managed: is_managed(&path), path: path.to_string_lossy().to_string(), version });
        break;
    }

    Tools {
        ytdlp_outdated: ytdlp.as_ref().map(|t| is_outdated(&t.version)).unwrap_or(false),
        ytdlp,
        ffmpeg,
        folder: tools_folder().to_string_lossy().to_string(),
    }
}

// MARK: - Installing

async fn download(url: &str, target: &Path, progress: impl Fn(f64)) -> Result<(), String> {
    let client = reqwest::Client::builder().user_agent("Guppy").build().map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(|e| format!("The download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The download failed (HTTP {}).", response.status().as_u16()));
    }
    let total = response.content_length().unwrap_or(0);
    let partial = target.with_extension("part");
    let mut file = tokio::fs::File::create(&partial).await.map_err(|e| e.to_string())?;
    let mut received: u64 = 0;
    let mut last_report = 0.0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The download was interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if total > 0 {
            let fraction = received as f64 / total as f64;
            if fraction - last_report >= 0.005 {
                last_report = fraction;
                progress(fraction);
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&partial, target).await
        .map_err(|e| format!("{} couldn't be replaced: {e}", target.display()))?;
    progress(1.0);
    Ok(())
}

/// Downloads the latest yt-dlp into Guppy's folder (replacing an older copy there).
pub async fn install_ytdlp(progress: impl Fn(f64)) -> Result<(), String> {
    let folder = tools_folder();
    tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
    download(YTDLP_URL, &folder.join(executable_name("yt-dlp")), progress).await
}

/// Downloads FFmpeg (the build yt-dlp recommends) and unpacks ffmpeg.exe and ffprobe.exe into Guppy's folder.
pub async fn install_ffmpeg(progress: impl Fn(f64)) -> Result<(), String> {
    let folder = tools_folder();
    tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
    let archive = folder.join("ffmpeg.zip");
    download(FFMPEG_URL, &archive, progress).await?;
    let result = {
        let (archive, folder) = (archive.clone(), folder.clone());
        tokio::task::spawn_blocking(move || unpack_ffmpeg(&archive, &folder)).await.map_err(|e| e.to_string())?
    };
    let _ = tokio::fs::remove_file(&archive).await;
    result
}

fn unpack_ffmpeg(archive: &Path, folder: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("The FFmpeg download is damaged: {e}"))?;
    let mut found = false;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let Some(file_name) = ["ffmpeg.exe", "ffprobe.exe"].into_iter().find(|f| name.ends_with(&format!("/bin/{f}"))) else {
            continue;
        };
        let mut output = std::fs::File::create(folder.join(file_name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        found |= file_name == "ffmpeg.exe";
    }
    if found { Ok(()) } else { Err("The FFmpeg download didn't contain ffmpeg.exe.".into()) }
}

// MARK: - Running

pub fn command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        // Don't flash a console window.
        command.creation_flags(0x0800_0000);
    }
    // yt-dlp is a Python program; make it write UTF-8 so titles with accents survive.
    command.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command
}

pub enum Line {
    Out(String),
    Err(String),
}

/// Sends every line `reader` writes (ended by \n or \r) to `sender`.
fn forward(reader: impl AsyncRead + Unpin + Send + 'static, sender: mpsc::UnboundedSender<Line>, wrap: fn(String) -> Line) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    for part in String::from_utf8_lossy(&buffer).split(['\r', '\n']) {
                        if !part.trim().is_empty() && sender.send(wrap(part.to_string())).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
}

/// Ends the process and everything it started (yt-dlp runs FFmpeg, and its .exe is a launcher for Python).
async fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = command(Path::new("taskkill")).args(["/PID", &pid.to_string(), "/T", "/F"]).output().await;
    }
    let _ = child.kill().await;
}

/// Runs `command`, handing each line it writes to `on_line`. Returns whether it succeeded and the lines it wrote
/// to standard error. Setting `cancelled` ends it and returns the error "cancelled".
pub async fn run(mut command: Command, cancelled: Arc<AtomicBool>,
                 mut on_line: impl FnMut(&Line)) -> Result<(bool, Vec<String>), String> {
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let (sender, mut receiver) = mpsc::unbounded_channel();
    forward(child.stdout.take().unwrap(), sender.clone(), Line::Out);
    forward(child.stderr.take().unwrap(), sender, Line::Err);

    let mut errors = Vec::new();
    loop {
        if cancelled.load(Ordering::SeqCst) {
            kill_tree(&mut child).await;
            return Err("cancelled".into());
        }
        match tokio::time::timeout(std::time::Duration::from_millis(100), receiver.recv()).await {
            Err(_) => continue,
            Ok(None) => break,
            Ok(Some(line)) => {
                on_line(&line);
                if let Line::Err(text) = line {
                    errors.push(text);
                }
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok((status.success(), errors))
}
