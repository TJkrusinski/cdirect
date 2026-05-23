use std::{
    fs::File,
    path::{Path, PathBuf},
};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub inputs: InputsConfig,
    #[serde(default)]
    pub segment: SegmentConfig,
    #[serde(default)]
    pub encode: EncodeConfig,
    pub s3: S3Config,
}

impl AppConfig {
    pub fn from_path(path: &Path) -> Result<Self, ConfigError> {
        let file = File::open(path)?;
        let mut config: Self = serde_yaml::from_reader(file)?;
        config.expand_env()?;
        Ok(config)
    }

    fn expand_env(&mut self) -> Result<(), ConfigError> {
        expand_env_ref(&mut self.s3.bucket)?;
        expand_env_ref(&mut self.s3.prefix)?;

        if let Some(region) = &mut self.s3.region {
            expand_env_ref(region)?;
        }
        if let Some(endpoint_url) = &mut self.s3.endpoint_url {
            expand_env_ref(endpoint_url)?;
        }

        if matches!(self.inputs.source, InputSource::File) && self.inputs.file.is_none() {
            return Err(ConfigError::MissingFileInput);
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputsConfig {
    #[serde(default)]
    pub source: InputSource,
    #[serde(default)]
    pub audio: InputSelector,
    #[serde(default)]
    pub video: InputSelector,
    pub file: Option<FileInputConfig>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InputSource {
    Avfoundation,
    File,
}

impl Default for InputSource {
    fn default() -> Self {
        Self::Avfoundation
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputSelector {
    pub name: Option<String>,
    pub id: Option<String>,
}

impl Default for InputSelector {
    fn default() -> Self {
        Self {
            name: None,
            id: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileInputConfig {
    pub path: PathBuf,
    #[serde(default = "default_file_loop_input")]
    pub loop_input: bool,
    #[serde(default)]
    pub realtime: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SegmentConfig {
    #[serde(default = "default_segment_duration_seconds")]
    pub duration_seconds: u32,
    #[serde(default = "default_segment_extension")]
    pub extension: String,
    #[serde(default = "default_segment_prefix")]
    pub prefix: String,
    #[serde(default = "default_manifest_name")]
    pub manifest_name: String,
    #[serde(default = "default_segment_window_size")]
    pub window_size: u32,
    #[serde(default = "default_segment_extra_window_size")]
    pub extra_window_size: u32,
}

impl Default for SegmentConfig {
    fn default() -> Self {
        Self {
            duration_seconds: default_segment_duration_seconds(),
            extension: default_segment_extension(),
            prefix: default_segment_prefix(),
            manifest_name: default_manifest_name(),
            window_size: default_segment_window_size(),
            extra_window_size: default_segment_extra_window_size(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct EncodeConfig {
    #[serde(default)]
    pub video: VideoEncodeConfig,
    #[serde(default)]
    pub audio: AudioEncodeConfig,
}

impl Default for EncodeConfig {
    fn default() -> Self {
        Self {
            video: VideoEncodeConfig::default(),
            audio: AudioEncodeConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoEncodeConfig {
    #[serde(default = "default_video_codec")]
    pub codec: String,
    #[serde(default = "default_video_preset")]
    pub preset: String,
    #[serde(default = "default_video_bitrate")]
    pub bitrate: String,
    #[serde(default = "default_video_maxrate")]
    pub maxrate: String,
    #[serde(default = "default_video_bufsize")]
    pub bufsize: String,
    #[serde(default = "default_video_width")]
    pub width: u32,
    #[serde(default = "default_video_height")]
    pub height: u32,
    #[serde(default = "default_video_framerate")]
    pub framerate: u32,
}

impl Default for VideoEncodeConfig {
    fn default() -> Self {
        Self {
            codec: default_video_codec(),
            preset: default_video_preset(),
            bitrate: default_video_bitrate(),
            maxrate: default_video_maxrate(),
            bufsize: default_video_bufsize(),
            width: default_video_width(),
            height: default_video_height(),
            framerate: default_video_framerate(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AudioEncodeConfig {
    #[serde(default = "default_audio_codec")]
    pub codec: String,
    #[serde(default = "default_audio_bitrate")]
    pub bitrate: String,
    #[serde(default = "default_audio_sample_rate")]
    pub sample_rate: u32,
    #[serde(default = "default_audio_channels")]
    pub channels: u8,
}

impl Default for AudioEncodeConfig {
    fn default() -> Self {
        Self {
            codec: default_audio_codec(),
            bitrate: default_audio_bitrate(),
            sample_rate: default_audio_sample_rate(),
            channels: default_audio_channels(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct S3Config {
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    pub region: Option<String>,
    pub endpoint_url: Option<String>,
    #[serde(default)]
    pub force_path_style: bool,
}

fn default_file_loop_input() -> bool {
    true
}

fn default_segment_duration_seconds() -> u32 {
    2
}

fn default_segment_extension() -> String {
    "m4s".to_string()
}

fn default_segment_prefix() -> String {
    "segments".to_string()
}

fn default_manifest_name() -> String {
    "manifest.mpd".to_string()
}

fn default_segment_window_size() -> u32 {
    12
}

fn default_segment_extra_window_size() -> u32 {
    6
}

fn default_video_codec() -> String {
    "libx264".to_string()
}

fn default_video_preset() -> String {
    "veryfast".to_string()
}

fn default_video_bitrate() -> String {
    "4500k".to_string()
}

fn default_video_maxrate() -> String {
    "7000k".to_string()
}

fn default_video_bufsize() -> String {
    "14000k".to_string()
}

fn default_video_width() -> u32 {
    1920
}

fn default_video_height() -> u32 {
    1080
}

fn default_video_framerate() -> u32 {
    30
}

fn default_audio_codec() -> String {
    "aac".to_string()
}

fn default_audio_bitrate() -> String {
    "160k".to_string()
}

fn default_audio_sample_rate() -> u32 {
    48_000
}

fn default_audio_channels() -> u8 {
    2
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config file: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse config yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("environment variable {0} referenced by config is not set")]
    MissingEnv(String),
    #[error("inputs.source is file, but inputs.file was not configured")]
    MissingFileInput,
}

fn expand_env_ref(value: &mut String) -> Result<(), ConfigError> {
    let Some(variable_name) = value
        .strip_prefix("${")
        .and_then(|remaining| remaining.strip_suffix('}'))
    else {
        return Ok(());
    };

    *value =
        std::env::var(variable_name).map_err(|_| ConfigError::MissingEnv(variable_name.into()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_plain_values_unchanged() {
        let mut value = "bucket".to_string();

        expand_env_ref(&mut value).unwrap();

        assert_eq!(value, "bucket");
    }
}
