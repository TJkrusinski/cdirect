use std::{
    env,
    error::Error,
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use aws_config::BehaviorVersion;
use aws_sdk_s3::Client;
use aws_types::region::Region;
use bytes::Bytes;
use cdirect::{
    config::{
        AppConfig, AudioEncodeConfig, EncodeConfig, FileInputConfig, InputSelector, InputSource,
        InputsConfig, S3Config, SegmentConfig, VideoEncodeConfig,
    },
    pipeline,
    segment::Segment,
};
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;

#[tokio::test]
#[ignore = "requires ffmpeg, ffprobe, media fixture, and S3/S3-compatible test bucket"]
async fn publishes_file_fixture_segment_and_manifest() -> TestResult {
    let Some(media_path) = file_fixture_path() else {
        eprintln!(
            "skipping: set CDIRECT_TEST_MEDIA_PATH or place Big Buck Bunny at tests/fixtures/big_buck_bunny.mp4"
        );
        return Ok(());
    };
    let Some(s3) = s3_config("file") else {
        eprintln!("skipping: set CDIRECT_TEST_S3_BUCKET for integration tests");
        return Ok(());
    };

    require_command("ffmpeg")?;
    require_command("ffprobe")?;

    let config = AppConfig {
        inputs: InputsConfig {
            source: InputSource::File,
            audio: InputSelector::default(),
            video: InputSelector::default(),
            file: Some(FileInputConfig {
                path: media_path,
                loop_input: true,
                realtime: false,
            }),
        },
        segment: test_segment_config(),
        encode: test_encode_config(),
        s3,
    };

    pipeline::run_for_segments(config.clone(), 1).await?;
    validate_published_segment(&config).await
}

#[tokio::test]
#[ignore = "requires macOS camera/mic permissions, ffmpeg, ffprobe, and S3/S3-compatible test bucket"]
async fn publishes_webcam_and_mic_segment_and_manifest() -> TestResult {
    if !cfg!(target_os = "macos") {
        eprintln!("skipping: AVFoundation capture is only available on macOS");
        return Ok(());
    }

    let Some(s3) = s3_config("avfoundation") else {
        eprintln!("skipping: set CDIRECT_TEST_S3_BUCKET for integration tests");
        return Ok(());
    };
    let Some(audio_id) = env::var("CDIRECT_TEST_AVFOUNDATION_AUDIO_ID").ok() else {
        eprintln!("skipping: set CDIRECT_TEST_AVFOUNDATION_AUDIO_ID");
        return Ok(());
    };
    let Some(video_id) = env::var("CDIRECT_TEST_AVFOUNDATION_VIDEO_ID").ok() else {
        eprintln!("skipping: set CDIRECT_TEST_AVFOUNDATION_VIDEO_ID");
        return Ok(());
    };

    require_command("ffmpeg")?;
    require_command("ffprobe")?;

    let config = AppConfig {
        inputs: InputsConfig {
            source: InputSource::Avfoundation,
            audio: InputSelector {
                id: Some(audio_id),
                name: None,
            },
            video: InputSelector {
                id: Some(video_id),
                name: None,
            },
            file: None,
        },
        segment: test_segment_config(),
        encode: test_encode_config(),
        s3,
    };

    pipeline::run_for_segments(config.clone(), 1).await?;
    validate_published_segment(&config).await
}

fn test_segment_config() -> SegmentConfig {
    SegmentConfig {
        duration_seconds: 2,
        extension: "m4s".to_string(),
        prefix: "segments".to_string(),
        manifest_name: "manifest.mpd".to_string(),
        window_size: 12,
        extra_window_size: 6,
    }
}

fn test_encode_config() -> EncodeConfig {
    EncodeConfig {
        video: VideoEncodeConfig {
            bitrate: "900k".to_string(),
            maxrate: "1200k".to_string(),
            bufsize: "2400k".to_string(),
            width: 640,
            height: 360,
            framerate: 24,
            ..VideoEncodeConfig::default()
        },
        audio: AudioEncodeConfig {
            bitrate: "96k".to_string(),
            sample_rate: 48_000,
            channels: 2,
            ..AudioEncodeConfig::default()
        },
    }
}

fn file_fixture_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("CDIRECT_TEST_MEDIA_PATH") {
        return Some(path.into());
    }

    let default_path = PathBuf::from("tests/fixtures/big_buck_bunny.mp4");
    default_path.exists().then_some(default_path)
}

fn s3_config(kind: &str) -> Option<S3Config> {
    let bucket = env::var("CDIRECT_TEST_S3_BUCKET").ok()?;
    let base_prefix =
        env::var("CDIRECT_TEST_S3_PREFIX").unwrap_or_else(|_| "cdirect-integration".to_string());
    let endpoint_url = env::var("CDIRECT_TEST_S3_ENDPOINT_URL").ok();
    let force_path_style = endpoint_url.is_some() || env_truthy("CDIRECT_TEST_S3_FORCE_PATH_STYLE");

    Some(S3Config {
        bucket,
        prefix: format!(
            "{}/{kind}-{}-{}",
            base_prefix.trim_matches('/'),
            std::process::id(),
            now_millis()
        ),
        region: Some(env::var("CDIRECT_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".into())),
        endpoint_url,
        force_path_style,
    })
}

async fn validate_published_segment(config: &AppConfig) -> TestResult {
    let client = s3_client(&config.s3).await;
    let manifest_key = Segment::manifest_key(&config.segment, &config.s3.prefix);
    let manifest_bytes = get_object_bytes(&client, &config.s3.bucket, &manifest_key).await?;
    let manifest = String::from_utf8(manifest_bytes.to_vec())?;

    assert!(
        manifest.contains("<MPD"),
        "manifest was not an MPD: {manifest}"
    );
    assert!(
        manifest.contains("<SegmentTemplate"),
        "manifest did not contain a SegmentTemplate: {manifest}"
    );
    assert!(
        manifest.contains("segments/init-stream$RepresentationID$.m4s"),
        "manifest did not reference init segments: {manifest}"
    );
    assert!(
        manifest.contains("segments/chunk-stream$RepresentationID$-"),
        "manifest did not reference media segments: {manifest}"
    );

    let object_prefix = format!(
        "{}/{}",
        config.s3.prefix.trim_matches('/'),
        config.segment.prefix.trim_matches('/')
    );
    let keys = list_object_keys(&client, &config.s3.bucket, &object_prefix).await?;
    let init_key = keys
        .iter()
        .find(|key| key.ends_with("init-stream0.m4s"))
        .ok_or("published DASH output did not include init-stream0.m4s")?;
    let media_key = keys
        .iter()
        .find(|key| key.contains("chunk-stream0-") && key.ends_with(".m4s"))
        .ok_or("published DASH output did not include a stream0 media segment")?;

    let mut combined = get_object_bytes(&client, &config.s3.bucket, init_key)
        .await?
        .to_vec();
    combined.extend_from_slice(&get_object_bytes(&client, &config.s3.bucket, media_key).await?);
    assert!(
        combined.len() > 8 * 1024,
        "DASH init+media bytes were unexpectedly small: {} bytes",
        combined.len()
    );
    validate_media_streams(&combined)?;

    Ok(())
}

async fn s3_client(config: &S3Config) -> Client {
    let mut loader = aws_config::defaults(BehaviorVersion::latest());

    if let Some(region) = &config.region {
        loader = loader.region(Region::new(region.clone()));
    }

    let shared_config = loader.load().await;
    let mut client_config = aws_sdk_s3::config::Builder::from(&shared_config);

    if let Some(endpoint_url) = &config.endpoint_url {
        client_config = client_config.endpoint_url(endpoint_url.clone());
    }

    client_config = client_config.force_path_style(config.force_path_style);
    Client::from_conf(client_config.build())
}

async fn get_object_bytes(
    client: &Client,
    bucket: &str,
    key: &str,
) -> Result<Bytes, Box<dyn Error + Send + Sync>> {
    let output = client.get_object().bucket(bucket).key(key).send().await?;
    let bytes = output.body.collect().await?.into_bytes();

    Ok(bytes)
}

async fn list_object_keys(
    client: &Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<String>, Box<dyn Error + Send + Sync>> {
    let output = client
        .list_objects_v2()
        .bucket(bucket)
        .prefix(prefix)
        .send()
        .await?;

    Ok(output
        .contents()
        .iter()
        .filter_map(|object| object.key().map(ToString::to_string))
        .collect())
}

fn validate_media_streams(bytes: &[u8]) -> TestResult {
    let path = env::temp_dir().join(format!("cdirect-integration-{}.mp4", now_millis()));
    std::fs::write(&path, bytes)?;

    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height:format=duration",
            "-of",
            "json",
            path.to_str().expect("temp path should be valid utf-8"),
        ])
        .output()?;

    let _ = std::fs::remove_file(&path);

    assert!(
        output.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let json: Value = serde_json::from_slice(&output.stdout)?;
    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .ok_or("ffprobe output did not contain streams")?;

    assert!(
        streams
            .iter()
            .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video")),
        "segment did not contain a video stream: {json}"
    );
    assert!(
        streams
            .iter()
            .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio")),
        "segment did not contain an audio stream: {json}"
    );

    Ok(())
}

fn require_command(name: &str) -> TestResult {
    let status = Command::new(name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{name} -version exited with {status}").into()),
        Err(error) => Err(format!("{name} is required for integration tests: {error}").into()),
    }
}

fn env_truthy(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after unix epoch")
        .as_millis()
}
