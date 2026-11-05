//! Converts audio and video files on this PC to an audio format with FFmpeg.

use crate::tools::{self, Line, Tool};
use crate::Progress;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOptions {
    pub path: String,
    /// mp3, m4a, opus, flac or wav.
    pub format: String,
    /// kbps, for the lossy formats.
    pub bitrate: u32,
    pub folder: String,
}

/// A file in `folder` named `base` that doesn't exist yet ("base 2.ext" and so on).
pub fn unique_path(folder: &Path, base: &str, extension: &str) -> PathBuf {
    let mut path = folder.join(format!("{base}.{extension}"));
    let mut number = 2;
    while path.exists() {
        path = folder.join(format!("{base} {number}.{extension}"));
        number += 1;
    }
    path
}

fn codec_arguments(format: &str, bitrate: u32) -> Result<Vec<String>, String> {
    let bitrate = format!("{bitrate}k");
    let arguments: Vec<&str> = match format {
        "mp3" => vec!["-c:a", "libmp3lame", "-b:a", &bitrate],
        "m4a" => vec!["-c:a", "aac", "-b:a", &bitrate],
        "opus" => vec!["-c:a", "libopus", "-b:a", &bitrate],
        "flac" => vec!["-c:a", "flac"],
        "wav" => vec!["-c:a", "pcm_s16le"],
        _ => return Err(format!("Guppy can't convert to {format}.")),
    };
    Ok(arguments.into_iter().map(String::from).collect())
}

/// "Duration: 00:03:21.45, start: …" → 201.45
fn duration(line: &str) -> Option<f64> {
    let time = line.trim().strip_prefix("Duration:")?.split(',').next()?.trim();
    let parts: Vec<f64> = time.split(':').map(|p| p.parse::<f64>().ok()).collect::<Option<_>>()?;
    let [hours, minutes, seconds] = parts[..] else { return None };
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Converts the file. Returns the new file.
pub async fn convert(ffmpeg: &Tool, options: &ConvertOptions, cancelled: Arc<AtomicBool>,
                     progress: impl Fn(Progress)) -> Result<String, String> {
    let source = Path::new(&options.path);
    let base = source.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Audio".into());
    let folder = PathBuf::from(&options.folder);
    std::fs::create_dir_all(&folder).map_err(|e| format!("The folder {} can't be used: {e}", folder.display()))?;
    let target = unique_path(&folder, &base, &options.format);

    let mut command = tools::command(Path::new(&ffmpeg.path));
    command.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(source)
        .args(["-vn", "-map_metadata", "0"])
        .args(codec_arguments(&options.format, options.bitrate)?)
        .args(["-progress", "pipe:1", "-nostats"])
        .arg(&target);

    let mut total: Option<f64> = None;
    let (ok, errors) = tools::run(command, cancelled, |line| match line {
        Line::Err(text) => {
            if total.is_none() {
                total = duration(text);
            }
        }
        Line::Out(text) => {
            // -progress writes key=value lines; out_time_us is the position in microseconds.
            if let (Some(position), Some(total)) = (text.strip_prefix("out_time_us="), total) {
                if let Ok(microseconds) = position.trim().parse::<f64>() {
                    let fraction = (microseconds / 1_000_000.0 / total).clamp(0.0, 1.0);
                    progress(Progress { fraction: Some(fraction), speed: None, eta: None, stage: "converting" });
                }
            }
        }
    }).await.inspect_err(|_| {
        let _ = std::fs::remove_file(&target);
    })?;
    if !ok {
        let _ = std::fs::remove_file(&target);
        let message = errors.last().map(|l| l.trim().to_string()).unwrap_or_else(|| "it stopped unexpectedly.".into());
        return Err(format!("FFmpeg couldn't convert {}: {message}", source.display()));
    }
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_duration() {
        assert_eq!(duration("  Duration: 00:03:21.50, start: 0.000000, bitrate: 128 kb/s"), Some(201.5));
        assert_eq!(duration("Stream #0:0: Audio: aac"), None);
    }
}
