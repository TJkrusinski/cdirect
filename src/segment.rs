use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::config::SegmentConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Segment {
    pub sequence: i64,
    pub starts_at: DateTime<Utc>,
    pub duration_seconds: u32,
    pub key: String,
}

impl Segment {
    pub fn for_time(config: &SegmentConfig, s3_prefix: &str, now: DateTime<Utc>) -> Self {
        let duration = i64::from(config.duration_seconds);
        let sequence = now.timestamp().div_euclid(duration);
        Self::from_sequence(config, s3_prefix, sequence)
    }

    pub fn next_after(config: &SegmentConfig, s3_prefix: &str, now: DateTime<Utc>) -> Self {
        let duration = i64::from(config.duration_seconds);
        let sequence = now.timestamp().div_euclid(duration) + 1;
        let starts_at = Utc
            .timestamp_opt(sequence * duration, 0)
            .single()
            .expect("segment timestamp should be representable");

        Self::for_time(config, s3_prefix, starts_at)
    }

    pub fn after(config: &SegmentConfig, s3_prefix: &str, previous: &Self) -> Self {
        Self::from_sequence(config, s3_prefix, previous.sequence + 1)
    }

    fn from_sequence(config: &SegmentConfig, s3_prefix: &str, sequence: i64) -> Self {
        let duration = i64::from(config.duration_seconds);
        let starts_at = Utc
            .timestamp_opt(sequence * duration, 0)
            .single()
            .expect("segment timestamp should be representable");
        let key = join_s3_key([
            s3_prefix,
            &config.prefix,
            &format!(
                "{}.{}",
                starts_at.format("%Y%m%dT%H%M%SZ"),
                config.extension
            ),
        ]);

        Self {
            sequence,
            starts_at,
            duration_seconds: config.duration_seconds,
            key,
        }
    }

    pub fn manifest_key(config: &SegmentConfig, s3_prefix: &str) -> String {
        join_s3_key([s3_prefix, &config.manifest_name])
    }
}

pub fn join_s3_key<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    parts
        .into_iter()
        .filter_map(|part| {
            let trimmed = part.trim_matches('/');
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::config::SegmentConfig;

    #[test]
    fn segment_key_is_deterministic_for_duration_slot() {
        let config = SegmentConfig {
            duration_seconds: 2,
            extension: "m4s".to_string(),
            prefix: "segments".to_string(),
            manifest_name: "manifest.mpd".to_string(),
            window_size: 12,
            extra_window_size: 6,
        };
        let now = Utc.with_ymd_and_hms(2026, 5, 22, 20, 0, 1).unwrap();

        let segment = Segment::for_time(&config, "/live/demo/", now);

        assert_eq!(segment.sequence, 889740000);
        assert_eq!(segment.key, "live/demo/segments/20260522T200000Z.m4s");
    }

    #[test]
    fn next_segment_starts_on_following_boundary() {
        let config = SegmentConfig {
            duration_seconds: 2,
            extension: "m4s".to_string(),
            prefix: "segments".to_string(),
            manifest_name: "manifest.mpd".to_string(),
            window_size: 12,
            extra_window_size: 6,
        };
        let now = Utc.with_ymd_and_hms(2026, 5, 22, 20, 0, 1).unwrap();

        let segment = Segment::next_after(&config, "live/demo", now);

        assert_eq!(
            segment.starts_at,
            Utc.with_ymd_and_hms(2026, 5, 22, 20, 0, 2).unwrap()
        );
        assert_eq!(segment.key, "live/demo/segments/20260522T200002Z.m4s");
    }

    #[test]
    fn joins_s3_keys_without_duplicate_slashes() {
        assert_eq!(join_s3_key(["/a/", "/b", "c/"]), "a/b/c");
    }
}
