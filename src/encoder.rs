use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};

use chrono::{DateTime, Utc};
use tokio::process::{Child, Command};

use crate::config::{AppConfig, FileInputConfig, InputSource};

#[derive(Debug)]
pub struct EncodedAsset {
    pub path: PathBuf,
    pub relative_path: String,
    pub kind: EncodedAssetKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodedAssetKind {
    Manifest,
    Media,
}

#[derive(Debug)]
pub struct FfmpegCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl FfmpegCommand {
    pub fn command_line(&self) -> String {
        let mut parts = vec![self.program.clone()];
        parts.extend(self.args.iter().map(|arg| shell_quote(arg)));
        parts.join(" ")
    }
}

pub struct Encoder {
    config: AppConfig,
}

impl Encoder {
    pub fn new(config: AppConfig) -> Self {
        Self { config }
    }

    pub fn start_continuous(&self, spool: &SegmentSpool) -> Result<RunningEncoder, EncoderError> {
        let started_at = Utc::now();
        let command = self.ffmpeg_command_at(spool, started_at);
        println!("running encoder: {}", command.command_line());
        let child = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;

        Ok(RunningEncoder { child, started_at })
    }

    pub fn ffmpeg_command(&self, spool: &SegmentSpool) -> FfmpegCommand {
        self.ffmpeg_command_at(spool, Utc::now())
    }

    pub fn ffmpeg_command_at(
        &self,
        spool: &SegmentSpool,
        started_at: DateTime<Utc>,
    ) -> FfmpegCommand {
        let keyframe_interval =
            self.config.encode.video.framerate * self.config.segment.duration_seconds;
        let segment_duration = self.config.segment.duration_seconds.to_string();
        let keyframe_offset =
            seconds_until_next_segment_boundary(self.config.segment.duration_seconds, started_at);

        let mut args = vec!["-hide_banner".to_string(), "-y".to_string()];

        args.extend(self.input_args());
        args.extend([
            "-map".to_string(),
            "0:v:0".to_string(),
            "-map".to_string(),
            "0:a:0".to_string(),
            "-c:v".to_string(),
            self.config.encode.video.codec.clone(),
            "-preset".to_string(),
            self.config.encode.video.preset.clone(),
            "-b:v".to_string(),
            self.config.encode.video.bitrate.clone(),
            "-maxrate".to_string(),
            self.config.encode.video.maxrate.clone(),
            "-bufsize".to_string(),
            self.config.encode.video.bufsize.clone(),
            "-g".to_string(),
            keyframe_interval.to_string(),
            "-keyint_min".to_string(),
            keyframe_interval.to_string(),
            "-force_key_frames".to_string(),
            format!("expr:gte(t,n_forced*{segment_duration}+{keyframe_offset:.6})"),
            "-sc_threshold".to_string(),
            "0".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            "-c:a".to_string(),
            self.config.encode.audio.codec.clone(),
            "-b:a".to_string(),
            self.config.encode.audio.bitrate.clone(),
            "-ar".to_string(),
            self.config.encode.audio.sample_rate.to_string(),
            "-ac".to_string(),
            self.config.encode.audio.channels.to_string(),
            "-f".to_string(),
            "dash".to_string(),
            "-seg_duration".to_string(),
            segment_duration.clone(),
            "-dash_segment_type".to_string(),
            "mp4".to_string(),
            "-use_template".to_string(),
            "1".to_string(),
            "-use_timeline".to_string(),
            "1".to_string(),
            "-window_size".to_string(),
            self.config.segment.window_size.to_string(),
            "-extra_window_size".to_string(),
            self.config.segment.extra_window_size.to_string(),
            "-remove_at_exit".to_string(),
            "0".to_string(),
            "-init_seg_name".to_string(),
            spool.init_segment_template(&self.config.segment),
            "-media_seg_name".to_string(),
            spool.media_segment_template(&self.config.segment),
            "-adaptation_sets".to_string(),
            "id=0,streams=v id=1,streams=a".to_string(),
            spool.manifest_path.display().to_string(),
        ]);

        FfmpegCommand {
            program: "ffmpeg".to_string(),
            args,
        }
    }

    fn input_args(&self) -> Vec<String> {
        match self.config.inputs.source {
            InputSource::Avfoundation => {
                let input = avfoundation_input(
                    self.config.inputs.video.id.as_deref(),
                    self.config.inputs.audio.id.as_deref(),
                );

                vec![
                    "-f".to_string(),
                    "avfoundation".to_string(),
                    "-framerate".to_string(),
                    self.config.encode.video.framerate.to_string(),
                    "-video_size".to_string(),
                    format!(
                        "{}x{}",
                        self.config.encode.video.width, self.config.encode.video.height
                    ),
                    "-i".to_string(),
                    input,
                ]
            }
            InputSource::File => {
                let file = self
                    .config
                    .inputs
                    .file
                    .as_ref()
                    .expect("file input config should be validated before encoding");
                file_input_args(file)
            }
        }
    }
}

pub struct RunningEncoder {
    child: Child,
    started_at: DateTime<Utc>,
}

impl RunningEncoder {
    pub fn started_at(&self) -> DateTime<Utc> {
        self.started_at
    }

    pub async fn ensure_running(&mut self) -> Result<(), EncoderError> {
        if let Some(status) = self.child.try_wait()? {
            return Err(EncoderError::FfmpegFailed(status));
        }

        Ok(())
    }

    pub async fn shutdown(mut self) -> Result<(), EncoderError> {
        if self.child.try_wait()?.is_none() {
            self.child.kill().await?;
        }

        let status = self.child.wait().await?;
        if !status.success() && !status_was_terminated(status) {
            return Err(EncoderError::FfmpegFailed(status));
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct SegmentSpool {
    pub dir: PathBuf,
    pub manifest_path: PathBuf,
}

impl SegmentSpool {
    pub fn create(segment_config: &crate::config::SegmentConfig) -> Result<Self, EncoderError> {
        let dir = std::env::temp_dir().join(format!(
            "cdirect-spool-{}-{}",
            std::process::id(),
            chrono::Utc::now()
                .timestamp_nanos_opt()
                .unwrap_or_else(|| chrono::Utc::now().timestamp_micros() * 1_000)
        ));

        std::fs::create_dir_all(&dir)?;
        std::fs::create_dir_all(dir.join(relative_segment_prefix(segment_config)))?;

        Ok(Self {
            manifest_path: dir.join(&segment_config.manifest_name),
            dir,
        })
    }

    pub fn discover_assets(&self) -> Result<Vec<EncodedAsset>, EncoderError> {
        let mut assets = Vec::new();
        collect_assets(&self.dir, &self.dir, &mut assets)?;
        assets.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(assets)
    }

    fn init_segment_template(&self, segment_config: &crate::config::SegmentConfig) -> String {
        dash_relative_path(
            &relative_segment_prefix(segment_config),
            &format!(
                "init-stream$RepresentationID$.{}",
                segment_config.extension.trim_start_matches('.')
            ),
        )
    }

    fn media_segment_template(&self, segment_config: &crate::config::SegmentConfig) -> String {
        dash_relative_path(
            &relative_segment_prefix(segment_config),
            &format!(
                "chunk-stream$RepresentationID$-$Number%09d$.{}",
                segment_config.extension.trim_start_matches('.')
            ),
        )
    }
}

fn dash_relative_path(prefix: &str, file_name: &str) -> String {
    if prefix.is_empty() {
        file_name.to_string()
    } else {
        format!("{prefix}/{file_name}")
    }
}

fn collect_assets(
    root: &std::path::Path,
    dir: &std::path::Path,
    assets: &mut Vec<EncodedAsset>,
) -> Result<(), EncoderError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            collect_assets(root, &path, assets)?;
            continue;
        }

        if !file_type.is_file() || is_temporary_dash_file(&path) {
            continue;
        }

        let relative_path = path
            .strip_prefix(root)
            .expect("asset path should be inside spool")
            .to_string_lossy()
            .replace('\\', "/");
        let kind = if path.extension().and_then(|ext| ext.to_str()) == Some("mpd") {
            EncodedAssetKind::Manifest
        } else {
            EncodedAssetKind::Media
        };

        assets.push(EncodedAsset {
            path,
            relative_path,
            kind,
        });
    }

    Ok(())
}

fn is_temporary_dash_file(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.') || name.ends_with(".tmp"))
        .unwrap_or(false)
}

fn relative_segment_prefix(segment_config: &crate::config::SegmentConfig) -> String {
    segment_config.prefix.trim_matches('/').to_string()
}

fn seconds_until_next_segment_boundary(duration_seconds: u32, now: DateTime<Utc>) -> f64 {
    let duration_nanos = i128::from(duration_seconds) * 1_000_000_000;
    let timestamp_nanos =
        i128::from(now.timestamp()) * 1_000_000_000 + i128::from(now.timestamp_subsec_nanos());
    let remainder = timestamp_nanos.rem_euclid(duration_nanos);

    if remainder == 0 {
        0.0
    } else {
        (duration_nanos - remainder) as f64 / 1_000_000_000.0
    }
}

fn avfoundation_input(video_id: Option<&str>, audio_id: Option<&str>) -> String {
    format!("{}:{}", video_id.unwrap_or("0"), audio_id.unwrap_or("0"))
}

fn file_input_args(file: &FileInputConfig) -> Vec<String> {
    let mut args = Vec::new();

    if file.loop_input {
        args.extend(["-stream_loop".to_string(), "-1".to_string()]);
    }
    if file.realtime {
        args.push("-re".to_string());
    }

    args.extend(["-i".to_string(), file.path.display().to_string()]);

    args
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "-_./:=+".contains(character))
    {
        return value.to_string();
    }

    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn status_was_terminated(status: ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;

    status.signal().is_some()
}

#[cfg(not(unix))]
fn status_was_terminated(_status: ExitStatus) -> bool {
    false
}

#[derive(Debug, thiserror::Error)]
pub enum EncoderError {
    #[error("failed to run ffmpeg: {0}")]
    Io(#[from] std::io::Error),
    #[error("ffmpeg exited with status {0}")]
    FfmpegFailed(ExitStatus),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AppConfig, AudioEncodeConfig, EncodeConfig, FileInputConfig, InputSelector, InputSource,
        InputsConfig, S3Config, SegmentConfig, VideoEncodeConfig,
    };
    use chrono::TimeZone;

    #[test]
    fn builds_avfoundation_ffmpeg_command_from_config() {
        let config = AppConfig {
            inputs: InputsConfig {
                source: InputSource::Avfoundation,
                audio: InputSelector {
                    id: Some("1".to_string()),
                    name: None,
                },
                video: InputSelector {
                    id: Some("0".to_string()),
                    name: None,
                },
                file: None,
            },
            segment: SegmentConfig {
                duration_seconds: 4,
                extension: "m4s".to_string(),
                prefix: "segments".to_string(),
                manifest_name: "manifest.mpd".to_string(),
                window_size: 12,
                extra_window_size: 6,
            },
            encode: EncodeConfig {
                video: VideoEncodeConfig {
                    framerate: 30,
                    ..VideoEncodeConfig::default()
                },
                audio: AudioEncodeConfig::default(),
            },
            s3: S3Config {
                bucket: "bucket".to_string(),
                prefix: "live".to_string(),
                region: None,
                endpoint_url: None,
                force_path_style: false,
            },
        };
        let encoder = Encoder::new(config);
        let started_at = Utc.with_ymd_and_hms(2026, 5, 22, 20, 0, 1).unwrap();
        let spool = SegmentSpool {
            dir: "/tmp/cdirect".into(),
            manifest_path: "/tmp/cdirect/manifest.mpd".into(),
        };

        let command = encoder.ffmpeg_command_at(&spool, started_at);

        assert!(command.args.windows(2).any(|pair| pair == ["-i", "0:1"]));
        assert!(command.args.windows(2).any(|pair| pair == ["-g", "120"]));
        assert!(command.args.windows(2).any(|pair| pair == ["-f", "dash"]));
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-seg_duration", "4"])
        );
        assert!(command.args.windows(2).any(|pair| pair
            == [
                "-init_seg_name",
                "segments/init-stream$RepresentationID$.m4s"
            ]));
        assert!(command.args.windows(2).any(|pair| pair
            == [
                "-media_seg_name",
                "segments/chunk-stream$RepresentationID$-$Number%09d$.m4s"
            ]));
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-adaptation_sets", "id=0,streams=v id=1,streams=a"])
        );
        assert_eq!(
            command.args.last().map(String::as_str),
            Some("/tmp/cdirect/manifest.mpd")
        );
    }

    #[test]
    fn builds_file_input_ffmpeg_command_from_config() {
        let config = AppConfig {
            inputs: InputsConfig {
                source: InputSource::File,
                audio: InputSelector::default(),
                video: InputSelector::default(),
                file: Some(FileInputConfig {
                    path: "/tmp/big-buck-bunny.mp4".into(),
                    loop_input: true,
                    realtime: false,
                }),
            },
            segment: SegmentConfig {
                duration_seconds: 3,
                extension: "m4s".to_string(),
                prefix: "segments".to_string(),
                manifest_name: "manifest.mpd".to_string(),
                window_size: 12,
                extra_window_size: 6,
            },
            encode: EncodeConfig {
                video: VideoEncodeConfig {
                    framerate: 24,
                    ..VideoEncodeConfig::default()
                },
                audio: AudioEncodeConfig::default(),
            },
            s3: S3Config {
                bucket: "bucket".to_string(),
                prefix: "live".to_string(),
                region: None,
                endpoint_url: None,
                force_path_style: false,
            },
        };
        let encoder = Encoder::new(config);
        let started_at = Utc.with_ymd_and_hms(2026, 5, 22, 20, 0, 1).unwrap()
            + chrono::TimeDelta::milliseconds(250);
        let spool = SegmentSpool {
            dir: "/tmp/cdirect".into(),
            manifest_path: "/tmp/cdirect/manifest.mpd".into(),
        };

        let command = encoder.ffmpeg_command_at(&spool, started_at);

        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-stream_loop", "-1"])
        );
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-i", "/tmp/big-buck-bunny.mp4"])
        );
        assert!(command.args.windows(2).any(|pair| pair == ["-g", "72"]));
        assert!(
            command
                .args
                .windows(2)
                .any(|pair| pair == ["-force_key_frames", "expr:gte(t,n_forced*3+1.750000)"])
        );
    }

    #[tokio::test]
    async fn discovers_dash_assets_relative_to_spool_dir() {
        let dir = std::env::temp_dir().join(format!(
            "cdirect-asset-discovery-test-{}",
            std::process::id()
        ));
        let media_dir = dir.join("segments");
        tokio::fs::create_dir_all(&media_dir).await.unwrap();
        tokio::fs::write(dir.join("manifest.mpd"), "<MPD />")
            .await
            .unwrap();
        tokio::fs::write(media_dir.join("init-stream0.m4s"), b"init")
            .await
            .unwrap();
        tokio::fs::write(media_dir.join("chunk-stream0-000000001.m4s"), b"media")
            .await
            .unwrap();

        let spool = SegmentSpool {
            dir: dir.clone(),
            manifest_path: dir.join("manifest.mpd"),
        };

        let assets = spool.discover_assets().unwrap();
        let _ = tokio::fs::remove_dir_all(&dir).await;

        assert!(
            assets
                .iter()
                .any(|asset| asset.relative_path == "manifest.mpd")
        );
        assert!(
            assets
                .iter()
                .any(|asset| asset.relative_path == "segments/init-stream0.m4s")
        );
        assert!(
            assets
                .iter()
                .any(|asset| asset.relative_path == "segments/chunk-stream0-000000001.m4s")
        );
    }

    #[test]
    fn computes_seconds_until_next_segment_boundary() {
        let now = Utc.with_ymd_and_hms(2026, 5, 22, 20, 0, 1).unwrap()
            + chrono::TimeDelta::milliseconds(250);

        assert_eq!(seconds_until_next_segment_boundary(3, now), 1.75);
    }
}
