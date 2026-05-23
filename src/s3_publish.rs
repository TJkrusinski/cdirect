use aws_config::BehaviorVersion;
use aws_sdk_s3::Client;
use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_types::region::Region;
use bytes::Bytes;

use crate::config::{S3Config, SegmentConfig};
use crate::manifest::StreamManifest;
use crate::segment::Segment;

const MAX_MANIFEST_RETRIES: usize = 5;

#[derive(Debug)]
pub enum PublishOutcome {
    Published,
    SegmentAlreadyExists,
    ManifestAlreadyContainedSegment,
}

#[derive(Clone)]
pub struct S3Publisher {
    client: Client,
    bucket: String,
    prefix: String,
}

impl S3Publisher {
    pub async fn from_config(config: &S3Config) -> Self {
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
        let client = Client::from_conf(client_config.build());

        Self {
            client,
            bucket: config.bucket.clone(),
            prefix: config.prefix.clone(),
        }
    }

    pub async fn publish_segment(
        &self,
        segment_config: &SegmentConfig,
        segment: &Segment,
        bytes: Bytes,
    ) -> Result<PublishOutcome, PublishError> {
        let segment_put = self.put_segment_if_absent(segment, bytes).await?;
        let manifest_outcome = self
            .append_manifest_segment(segment_config, segment, segment_put.etag)
            .await?;

        Ok(match (segment_put.written, manifest_outcome) {
            (true, ManifestOutcome::Updated) => PublishOutcome::Published,
            (false, ManifestOutcome::Updated) => PublishOutcome::SegmentAlreadyExists,
            (_, ManifestOutcome::AlreadyContainedSegment) => {
                PublishOutcome::ManifestAlreadyContainedSegment
            }
        })
    }

    pub async fn publish_dash_asset(
        &self,
        relative_path: &str,
        bytes: Bytes,
        content_type: &str,
    ) -> Result<(), PublishError> {
        let key = crate::segment::join_s3_key([&self.prefix, relative_path]);
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(bytes))
            .content_type(content_type)
            .cache_control("no-store")
            .send()
            .await
            .map_err(|error| PublishError::S3(describe_aws_error(&error)))?;

        Ok(())
    }

    pub async fn check_bucket_access(&self) -> Result<(), PublishError> {
        self.client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .map_err(|error| PublishError::S3(describe_aws_error(&error)))?;

        Ok(())
    }

    async fn put_segment_if_absent(
        &self,
        segment: &Segment,
        bytes: Bytes,
    ) -> Result<SegmentPut, PublishError> {
        let result = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(&segment.key)
            .body(ByteStream::from(bytes))
            .if_none_match("*")
            .send()
            .await;

        match result {
            Ok(output) => Ok(SegmentPut {
                written: true,
                etag: output.e_tag().map(ToString::to_string),
            }),
            Err(error) if is_precondition_failed(&error) => Ok(SegmentPut {
                written: false,
                etag: None,
            }),
            Err(error) => Err(PublishError::S3(describe_aws_error(&error))),
        }
    }

    async fn append_manifest_segment(
        &self,
        segment_config: &SegmentConfig,
        segment: &Segment,
        segment_etag: Option<String>,
    ) -> Result<ManifestOutcome, PublishError> {
        let manifest_key = Segment::manifest_key(segment_config, &self.prefix);

        for _ in 0..MAX_MANIFEST_RETRIES {
            let loaded = self.get_manifest(&manifest_key).await?;
            let mut manifest = loaded
                .manifest
                .unwrap_or_else(|| StreamManifest::new(segment_config.duration_seconds));

            if !manifest.add_segment(segment, segment_etag.clone()) {
                return Ok(ManifestOutcome::AlreadyContainedSegment);
            }

            let body = Bytes::from(serde_json::to_vec_pretty(&manifest)?);
            match self
                .put_manifest_conditionally(&manifest_key, body, loaded.etag.as_deref())
                .await?
            {
                ConditionalPut::Written => return Ok(ManifestOutcome::Updated),
                ConditionalPut::PreconditionFailed => continue,
            }
        }

        Err(PublishError::ManifestContention)
    }

    async fn get_manifest(&self, key: &str) -> Result<LoadedManifest, PublishError> {
        let result = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await;

        let output = match result {
            Ok(output) => output,
            Err(error) if is_not_found(&error) => {
                return Ok(LoadedManifest {
                    manifest: None,
                    etag: None,
                });
            }
            Err(error) => return Err(PublishError::S3(describe_aws_error(&error))),
        };

        let etag = output.e_tag().map(ToString::to_string);
        let bytes = output
            .body
            .collect()
            .await
            .map_err(|error| PublishError::S3(error.to_string()))?
            .into_bytes();
        let manifest = serde_json::from_slice(&bytes)?;

        Ok(LoadedManifest {
            manifest: Some(manifest),
            etag,
        })
    }

    async fn put_manifest_conditionally(
        &self,
        key: &str,
        body: Bytes,
        etag: Option<&str>,
    ) -> Result<ConditionalPut, PublishError> {
        let request = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(body))
            .content_type("application/json");

        let request = match etag {
            Some(etag) => request.if_match(etag),
            None => request.if_none_match("*"),
        };

        match request.send().await {
            Ok(_) => Ok(ConditionalPut::Written),
            Err(error) if is_precondition_failed(&error) => Ok(ConditionalPut::PreconditionFailed),
            Err(error) => Err(PublishError::S3(describe_aws_error(&error))),
        }
    }
}

fn describe_aws_error(
    error: &(impl ProvideErrorMetadata + std::fmt::Display + std::fmt::Debug),
) -> String {
    match (error.code(), error.message()) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (Some(code), None) => code.to_string(),
        (None, Some(message)) => message.to_string(),
        (None, None) => format!("{error:?}"),
    }
}

fn is_precondition_failed(error: &(impl ProvideErrorMetadata + std::fmt::Display)) -> bool {
    error.code() == Some("PreconditionFailed") || error.to_string().contains("PreconditionFailed")
}

fn is_not_found(error: &(impl ProvideErrorMetadata + std::fmt::Display)) -> bool {
    matches!(error.code(), Some("NoSuchKey" | "NotFound"))
        || error.to_string().contains("NoSuchKey")
}

#[derive(Debug)]
struct SegmentPut {
    written: bool,
    etag: Option<String>,
}

#[derive(Debug)]
struct LoadedManifest {
    manifest: Option<StreamManifest>,
    etag: Option<String>,
}

#[derive(Debug)]
enum ConditionalPut {
    Written,
    PreconditionFailed,
}

#[derive(Debug)]
enum ManifestOutcome {
    Updated,
    AlreadyContainedSegment,
}

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("s3 request failed: {0}")]
    S3(String),
    #[error("failed to encode manifest json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("manifest update lost too many conditional-write races")]
    ManifestContention,
}
