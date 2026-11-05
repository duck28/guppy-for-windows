//! Reads what's behind a link and downloads it with yt-dlp.

use crate::tools::{self, Line, Tool};
use crate::Progress;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A video, or one video of a playlist.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub url: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub is_playlist: bool,
    pub title: String,
    pub channel: Option<String>,
    pub thumbnail: Option<String>,
    /// Video heights on offer (2160, 1080…), highest first. Empty for playlists.
    pub heights: Vec<u32>,
    /// The video itself, or the videos of the playlist.
    pub entries: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOptions {
    pub url: String,
    pub audio_only: bool,
    /// The highest video height to download; None for the best there is.
    pub max_height: Option<u32>,
    /// mp4, mkv or webm.
    pub container: String,
    /// mp3, m4a, opus, flac or wav.
    pub audio_format: String,
    /// kbps, for the lossy audio formats.
    pub audio_bitrate: u32,
    /// Cover art, title, artist and chapters.
    pub embed_metadata: bool,
    pub folder: String,
}

/// Deno is used automatically when it's on the PATH; Node or Bun have to be named explicitly.
/// (yt-dlp needs a JavaScript runtime for YouTube since 2025.11.)
fn javascript_runtime_arguments(tool: &Tool) -> Vec<String> {
    if tool.version.as_str() < "2025.11" || !tools::in_path("deno").is_empty() {
        return vec![];
    }
    let mut nodes = tools::in_path("node");
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        nodes.push(Path::new(&program_files).join("nodejs").join("node.exe"));
    }
    if let Some(node) = nodes.into_iter().find(|p| p.is_file()) {
        return vec!["--js-runtimes".into(), format!("node:{}", node.display())];
    }
    if let Some(bun) = tools::in_path("bun").into_iter().next() {
        return vec!["--js-runtimes".into(), format!("bun:{}", bun.display())];
    }
    vec![]
}

/// The error yt-dlp reported, in a sentence.
fn failure(errors: &[String]) -> String {
    let message = errors.iter().rev().find(|l| l.starts_with("ERROR:")).map(|l| l["ERROR:".len()..].trim().to_string())
        .or_else(|| errors.last().map(|l| l.trim().to_string()))
        .unwrap_or_else(|| "it stopped unexpectedly.".into());
    // "[youtube] abc123: Video unavailable" reads better without the prefix.
    let message = Regex::new(r"^\[[^\]]+\] [^:]+: ").unwrap().replace(&message, "").to_string();
    format!("{message} If this keeps happening, update yt-dlp in Settings.")
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

fn thumbnail(value: &Value) -> Option<String> {
    string(value, "thumbnail").or_else(|| {
        value.get("thumbnails")?.as_array()?.iter().rev().find_map(|t| string(t, "url"))
    })
}

fn entry(value: &Value) -> Option<Entry> {
    let url = string(value, "webpage_url").or_else(|| string(value, "url"))
        .or_else(|| string(value, "id").map(|id| format!("https://www.youtube.com/watch?v={id}")))?;
    let title = string(value, "title").unwrap_or_else(|| url.clone());
    // Flat playlists list videos that can't be watched under placeholder titles.
    if title == "[Private video]" || title == "[Deleted video]" {
        return None;
    }
    Some(Entry {
        url,
        title,
        channel: string(value, "channel").or_else(|| string(value, "uploader")),
        duration: value.get("duration").and_then(Value::as_f64),
        thumbnail: thumbnail(value),
    })
}

pub fn parse_info(json: &str) -> Result<MediaInfo, String> {
    let value: Value = serde_json::from_str(json).map_err(|_| "yt-dlp didn't describe this link.".to_string())?;
    if value.get("_type").and_then(Value::as_str) == Some("playlist") {
        let entries: Vec<Entry> = value.get("entries").and_then(Value::as_array)
            .map(|list| list.iter().filter_map(entry).collect()).unwrap_or_default();
        if entries.is_empty() {
            return Err("This playlist has no videos that can be downloaded.".into());
        }
        return Ok(MediaInfo {
            is_playlist: true,
            title: string(&value, "title").unwrap_or_else(|| "Playlist".into()),
            channel: string(&value, "channel").or_else(|| string(&value, "uploader")),
            thumbnail: thumbnail(&value).or_else(|| entries[0].thumbnail.clone()),
            heights: vec![],
            entries,
        });
    }
    let mut heights: Vec<u32> = value.get("formats").and_then(Value::as_array).map(|formats| formats.iter()
        .filter(|f| f.get("vcodec").and_then(Value::as_str) != Some("none"))
        .filter_map(|f| f.get("height").and_then(Value::as_u64).map(|h| h as u32))
        .collect()).unwrap_or_default();
    heights.sort_unstable_by(|a, b| b.cmp(a));
    heights.dedup();
    let video = entry(&value).ok_or("This video can't be downloaded.")?;
    Ok(MediaInfo {
        is_playlist: false,
        title: video.title.clone(),
        channel: video.channel.clone(),
        thumbnail: video.thumbnail.clone(),
        heights,
        entries: vec![video],
    })
}

/// What's behind `url`: a video (with its formats) or a playlist (with its videos).
pub async fn info(tool: &Tool, url: &str) -> Result<MediaInfo, String> {
    let mut command = tools::command(Path::new(&tool.path));
    command.args(javascript_runtime_arguments(tool))
        .args(["-J", "--flat-playlist", "--no-playlist", "--no-warnings", "--encoding", "utf-8", url]);
    let mut json = String::new();
    let (ok, errors) = tools::run(command, Arc::new(AtomicBool::new(false)), |line| {
        if let Line::Out(text) = line {
            json.push_str(text);
        }
    }).await?;
    if !ok {
        return Err(failure(&errors));
    }
    parse_info(&json)
}

fn arguments(options: &DownloadOptions, ffmpeg: &Tool) -> Vec<String> {
    let mut arguments: Vec<String> = [
        "--no-playlist", "--newline", "--progress", "--no-simulate", "--encoding", "utf-8",
        "--ffmpeg-location", ffmpeg.path.as_str(),
        "-P", options.folder.as_str(), "-o", "%(title)s.%(ext)s",
        "--progress-template",
        "download:GUPPY_DL|%(progress.filename)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
        "--progress-template", "postprocess:GUPPY_PP|%(progress.postprocessor)s|%(progress.status)s",
        "--print", "after_move:GUPPY_FILE|%(filepath)s",
    ].iter().map(|s| s.to_string()).collect();
    let mut add = |items: &[&str]| arguments.extend(items.iter().map(|s| s.to_string()));

    let can_embed_thumbnail;
    if options.audio_only {
        let format = options.audio_format.as_str();
        // Take the stream that needs no conversion when there is one.
        let selector = match format { "m4a" => "ba[ext=m4a]/ba/b", "opus" => "ba[acodec=opus]/ba/b", _ => "ba/b" };
        add(&["-f", selector, "-x", "--audio-format", format]);
        if format != "flac" && format != "wav" {
            add(&["--audio-quality", &format!("{}K", options.audio_bitrate)]);
        }
        can_embed_thumbnail = format != "wav";
    } else {
        let container = options.container.as_str();
        let resolution = options.max_height.map(|h| format!("res:{h}")).unwrap_or_else(|| "res".into());
        // Prefer codecs every player can open in that container.
        let sort = match container {
            "webm" => format!("{resolution},vcodec:vp9,acodec:opus"),
            "mkv" => resolution,
            _ => format!("{resolution},vcodec:h264,acodec:aac"),
        };
        add(&["-f", "bv*+ba/b", "-S", &sort, "--merge-output-format", container, "--remux-video", container]);
        if options.embed_metadata {
            add(&["--embed-chapters"]);
        }
        can_embed_thumbnail = container != "webm";
    }
    if options.embed_metadata {
        add(&["--embed-metadata"]);
        if can_embed_thumbnail {
            add(&["--embed-thumbnail", "--convert-thumbnails", "jpg"]);
        }
    }
    arguments.push(options.url.clone());
    arguments
}

fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Downloads a video or its audio. Returns the saved file.
pub async fn download(tool: &Tool, ffmpeg: &Tool, options: &DownloadOptions, cancelled: Arc<AtomicBool>,
                      progress: impl Fn(Progress)) -> Result<String, String> {
    std::fs::create_dir_all(&options.folder).map_err(|e| format!("The folder {} can't be used: {e}", options.folder))?;
    let mut command = tools::command(Path::new(&tool.path));
    command.args(javascript_runtime_arguments(tool)).args(arguments(options, ffmpeg));

    // A video and its audio are downloaded separately (as "Title.f137.mp4" and "Title.f140.m4a") and then merged.
    let stream_part = Regex::new(r"\.f[0-9A-Za-z_-]+\.[0-9A-Za-z]+(\.part)?$").unwrap();
    let mut files: Vec<String> = Vec::new();
    let mut saved: Option<String> = None;
    let mut last_report = Instant::now() - Duration::from_secs(1);

    let (ok, errors) = tools::run(command, cancelled, |line| match line {
        Line::Out(text) => {
            if let Some(file) = text.strip_prefix("GUPPY_FILE|") {
                saved = Some(file.trim().to_string());
            } else if let Some(fields) = text.strip_prefix("GUPPY_DL|") {
                // filename|downloaded|total|speed|eta; file names can't contain "|".
                let parts: Vec<&str> = fields.rsplitn(5, '|').collect();
                let [eta, speed, total, downloaded, file] = parts[..] else { return };
                if !files.iter().any(|f| f == file) {
                    files.push(file.to_string());
                }
                if last_report.elapsed() < Duration::from_millis(120) { return; }
                last_report = Instant::now();
                let fraction = match (number(downloaded), number(total)) {
                    (Some(d), Some(t)) if t > 0.0 => Some((d / t).min(1.0)),
                    _ => None,
                };
                // The video is most of the bytes: count it as 85 %, the audio as the rest.
                let overall = fraction.map(|f| match (stream_part.is_match(file), files.len()) {
                    (false, _) => f,
                    (true, 1) => f * 0.85,
                    (true, _) => 0.85 + f * 0.15,
                });
                progress(Progress { fraction: overall, speed: number(speed), eta: number(eta), stage: "downloading" });
            }
        }
        Line::Err(text) => {
            if let Some(fields) = text.strip_prefix("GUPPY_PP|") {
                let mut parts = fields.split('|');
                let (name, status) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                if status == "started" && name != "MoveFiles" {
                    progress(Progress { fraction: None, speed: None, eta: None, stage: "processing" });
                }
            }
        }
    }).await?;
    if !ok {
        return Err(failure(&errors));
    }
    saved.ok_or_else(|| "yt-dlp finished without saving a file.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_video() {
        let json = r#"{"id":"abc","title":"A video","channel":"Someone","duration":61.5,
            "webpage_url":"https://www.youtube.com/watch?v=abc","thumbnail":"https://i.ytimg.com/vi/abc/hq.jpg",
            "formats":[{"vcodec":"none","height":null},{"vcodec":"avc1","height":720},{"vcodec":"vp9","height":1080},
                       {"vcodec":"avc1","height":720}]}"#;
        let info = parse_info(json).unwrap();
        assert!(!info.is_playlist);
        assert_eq!(info.heights, vec![1080, 720]);
        assert_eq!(info.entries.len(), 1);
        assert_eq!(info.entries[0].duration, Some(61.5));
    }

    #[test]
    fn reads_a_playlist_without_private_videos() {
        let json = r#"{"_type":"playlist","title":"Mix","entries":[
            {"id":"a","title":"One","url":"https://www.youtube.com/watch?v=a","thumbnails":[{"url":"https://i.ytimg.com/a.jpg"}]},
            {"id":"b","title":"[Private video]","url":"https://www.youtube.com/watch?v=b"}]}"#;
        let info = parse_info(json).unwrap();
        assert!(info.is_playlist);
        assert_eq!(info.entries.len(), 1);
        assert_eq!(info.thumbnail.as_deref(), Some("https://i.ytimg.com/a.jpg"));
    }

    /// Downloads a 19-second video with the yt-dlp and FFmpeg on this PC: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn downloads_and_converts_with_the_real_tools() {
        let tools = tools::find().await;
        let (tool, ffmpeg) = (tools.ytdlp.expect("yt-dlp"), tools.ffmpeg.expect("FFmpeg"));
        let url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        let info = info(&tool, url).await.unwrap();
        assert_eq!(info.title, "Me at the zoo");
        assert!(!info.heights.is_empty());

        let folder = std::env::temp_dir().join(format!("guppy-test-{}", std::process::id()));
        let options = |audio_only: bool| DownloadOptions {
            url: url.into(), audio_only, max_height: Some(360), container: "mp4".into(), audio_format: "mp3".into(),
            audio_bitrate: 192, embed_metadata: true, folder: folder.to_string_lossy().to_string(),
        };
        let reports = std::sync::Mutex::new(0);
        let count = |_: Progress| *reports.lock().unwrap() += 1;
        let audio = download(&tool, &ffmpeg, &options(true), Arc::new(AtomicBool::new(false)), count).await.unwrap();
        assert!(audio.ends_with(".mp3") && Path::new(&audio).is_file(), "{audio}");
        let video = download(&tool, &ffmpeg, &options(false), Arc::new(AtomicBool::new(false)), count).await.unwrap();
        assert!(video.ends_with(".mp4") && Path::new(&video).is_file(), "{video}");
        assert!(*reports.lock().unwrap() > 0);

        let converted = crate::convert::convert(&ffmpeg, &crate::convert::ConvertOptions {
            path: video, format: "flac".into(), bitrate: 0, folder: folder.to_string_lossy().to_string(),
        }, Arc::new(AtomicBool::new(false)), |_| {}).await.unwrap();
        assert!(converted.ends_with(".flac") && Path::new(&converted).is_file(), "{converted}");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn explains_failures_without_prefixes() {
        let errors = vec!["WARNING: x".to_string(), "ERROR: [youtube] abc: Video unavailable".to_string()];
        assert!(failure(&errors).starts_with("Video unavailable"));
    }
}
