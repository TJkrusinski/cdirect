use std::collections::{HashMap, HashSet};
use std::path::Path;

use bytes::Bytes;
use tokio::time::{Duration, sleep};

use crate::config::{AppConfig, InputSource};
use crate::encoder::{EncodedAsset, EncodedAssetKind, Encoder, SegmentSpool};
use crate::s3_publish::S3Publisher;

const SEGMENT_POLL_INTERVAL: Duration = Duration::from_millis(200);

pub async fn run(config: AppConfig) -> Result<(), PipelineError> {
    run_segments(config, None).await
}

#[doc(hidden)]
pub async fn run_for_segments(
    config: AppConfig,
    segment_count: usize,
) -> Result<(), PipelineError> {
    run_segments(config, Some(segment_count)).await
}

async fn run_segments(
    config: AppConfig,
    segment_limit: Option<usize>,
) -> Result<(), PipelineError> {
    print_pipeline_summary(&config);
    println!("  mode: continuous live stream");

    let encoder = Encoder::new(config.clone());
    let spool = SegmentSpool::create(&config.segment)?;
    let mut running_encoder = Some(encoder.start_continuous(&spool)?);
    let publisher = S3Publisher::from_config(&config.s3).await;
    let mut stable_sizes = HashMap::new();
    let mut uploaded_media = HashSet::new();
    let mut uploaded_media_numbers: HashMap<String, HashSet<String>> = HashMap::new();
    let mut last_manifest_body: Option<Bytes> = None;

    loop {
        tokio::select! {
            () = sleep(SEGMENT_POLL_INTERVAL) => {}
            signal = tokio::signal::ctrl_c() => {
                signal.map_err(PipelineError::ShutdownSignal)?;
                println!("shutdown requested");
                if let Some(running_encoder) = running_encoder.take() {
                    running_encoder.shutdown().await?;
                }
                publish_ready_dash_assets(
                    &spool,
                    &publisher,
                    &mut stable_sizes,
                    &mut uploaded_media,
                    &mut uploaded_media_numbers,
                    &mut last_manifest_body,
                )
                .await?;
                cleanup_spool(&spool).await;
                return Ok(());
            }
        }

        if let Some(running_encoder) = &mut running_encoder {
            running_encoder.ensure_running().await?;
        }

        let published_manifest = publish_ready_dash_assets(
            &spool,
            &publisher,
            &mut stable_sizes,
            &mut uploaded_media,
            &mut uploaded_media_numbers,
            &mut last_manifest_body,
        )
        .await?;

        if published_manifest
            && segment_limit
                .is_some_and(|limit| complete_dash_segment_count(&uploaded_media_numbers) >= limit)
        {
            if let Some(running_encoder) = running_encoder.take() {
                running_encoder.shutdown().await?;
            }
            publish_ready_dash_assets(
                &spool,
                &publisher,
                &mut stable_sizes,
                &mut uploaded_media,
                &mut uploaded_media_numbers,
                &mut last_manifest_body,
            )
            .await?;
            cleanup_spool(&spool).await;
            return Ok(());
        }
    }
}

async fn publish_ready_dash_assets(
    spool: &SegmentSpool,
    publisher: &S3Publisher,
    stable_sizes: &mut HashMap<String, u64>,
    uploaded_media: &mut HashSet<String>,
    uploaded_media_numbers: &mut HashMap<String, HashSet<String>>,
    last_manifest_body: &mut Option<Bytes>,
) -> Result<bool, PipelineError> {
    let assets = spool.discover_assets()?;
    let mut manifest = None;
    let mut saw_unstable_media = false;

    for asset in assets {
        match asset.kind {
            EncodedAssetKind::Manifest => manifest = Some(asset),
            EncodedAssetKind::Media => {
                if uploaded_media.contains(&asset.relative_path) {
                    continue;
                }

                if !asset_size_is_stable(&asset, stable_sizes).await? {
                    saw_unstable_media = true;
                    continue;
                }

                publish_asset(publisher, &asset).await?;
                remember_media_segment(&asset.relative_path, uploaded_media_numbers);
                uploaded_media.insert(asset.relative_path.clone());
            }
        }
    }

    if saw_unstable_media {
        return Ok(false);
    }

    let Some(manifest) = manifest else {
        return Ok(false);
    };

    if !asset_size_is_stable(&manifest, stable_sizes).await? {
        return Ok(false);
    }

    let bytes = Bytes::from(tokio::fs::read(&manifest.path).await?);
    if last_manifest_body.as_ref() == Some(&bytes) {
        return Ok(false);
    }

    publisher
        .publish_dash_asset(
            &manifest.relative_path,
            bytes.clone(),
            content_type_for(&manifest.path),
        )
        .await?;
    *last_manifest_body = Some(bytes);
    println!("published DASH manifest");

    Ok(true)
}

async fn asset_size_is_stable(
    asset: &EncodedAsset,
    stable_sizes: &mut HashMap<String, u64>,
) -> Result<bool, PipelineError> {
    let len = tokio::fs::metadata(&asset.path).await?.len();
    if len == 0 {
        return Ok(false);
    }

    let was_stable = stable_sizes
        .get(&asset.relative_path)
        .is_some_and(|previous_len| *previous_len == len);
    stable_sizes.insert(asset.relative_path.clone(), len);
    Ok(was_stable)
}

async fn publish_asset(publisher: &S3Publisher, asset: &EncodedAsset) -> Result<(), PipelineError> {
    let bytes = Bytes::from(tokio::fs::read(&asset.path).await?);
    publisher
        .publish_dash_asset(&asset.relative_path, bytes, content_type_for(&asset.path))
        .await?;
    println!("published DASH asset {}", asset.relative_path);
    Ok(())
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("mpd") => "application/dash+xml",
        Some("m4s" | "mp4") => "video/iso.segment",
        _ => "application/octet-stream",
    }
}

fn remember_media_segment(
    relative_path: &str,
    uploaded_media_numbers: &mut HashMap<String, HashSet<String>>,
) {
    let Some((representation, number)) = dash_media_identity(relative_path) else {
        return;
    };

    uploaded_media_numbers
        .entry(number)
        .or_default()
        .insert(representation);
}

fn dash_media_identity(relative_path: &str) -> Option<(String, String)> {
    let file_name = relative_path.rsplit('/').next()?;
    let stem = file_name.strip_suffix(".m4s")?;
    let (representation, number) = stem.rsplit_once('-')?;

    if !representation.starts_with("chunk-stream") || number.is_empty() {
        return None;
    }

    Some((representation.to_string(), number.to_string()))
}

fn complete_dash_segment_count(uploaded_media_numbers: &HashMap<String, HashSet<String>>) -> usize {
    uploaded_media_numbers
        .values()
        .filter(|representations| representations.len() >= 2)
        .count()
}

fn print_pipeline_summary(config: &AppConfig) {
    println!("cdirect pipeline");
    match &config.inputs.source {
        InputSource::Avfoundation => {
            println!(
                "  audio input: {}",
                selector_label(
                    config.inputs.audio.name.as_deref(),
                    config.inputs.audio.id.as_deref()
                )
            );
            println!(
                "  video input: {}",
                selector_label(
                    config.inputs.video.name.as_deref(),
                    config.inputs.video.id.as_deref()
                )
            );
        }
        InputSource::File => {
            let path = config
                .inputs
                .file
                .as_ref()
                .map(|file| file.path.display().to_string())
                .unwrap_or_else(|| "unconfigured".to_string());
            println!("  file input: {path}");
        }
    }
    println!("  segment duration: {}s", config.segment.duration_seconds);
    println!(
        "  encode video: {} {}x{}@{} {}",
        config.encode.video.codec,
        config.encode.video.width,
        config.encode.video.height,
        config.encode.video.framerate,
        config.encode.video.bitrate
    );
    println!(
        "  encode audio: {} {} {}hz {}ch",
        config.encode.audio.codec,
        config.encode.audio.bitrate,
        config.encode.audio.sample_rate,
        config.encode.audio.channels
    );
    println!(
        "  s3 destination: s3://{}/{}",
        config.s3.bucket, config.s3.prefix
    );

    if let Some(region) = &config.s3.region {
        println!("  s3 region: {region}");
    }
}

fn selector_label(name: Option<&str>, id: Option<&str>) -> String {
    match (name, id) {
        (Some(name), Some(id)) => format!("{name} ({id})"),
        (Some(name), None) => name.to_string(),
        (None, Some(id)) => id.to_string(),
        (None, None) => "unspecified".to_string(),
    }
}

async fn cleanup_spool(spool: &SegmentSpool) {
    if let Err(error) = tokio::fs::remove_dir_all(&spool.dir).await {
        eprintln!(
            "warning: failed to remove segment spool '{}': {error}",
            spool.dir.display()
        );
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error("{0}")]
    Encoder(#[from] crate::encoder::EncoderError),
    #[error("failed to read encoded segment: {0}")]
    ReadSegment(#[from] std::io::Error),
    #[error("{0}")]
    Publish(#[from] crate::s3_publish::PublishError),
    #[error("failed to listen for shutdown signal: {0}")]
    ShutdownSignal(std::io::Error),
}
