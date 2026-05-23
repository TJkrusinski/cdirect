use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::segment::Segment;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamManifest {
    pub version: u8,
    pub updated_at: DateTime<Utc>,
    pub segment_duration_seconds: u32,
    pub segments: Vec<ManifestSegment>,
}

impl StreamManifest {
    pub fn new(segment_duration_seconds: u32) -> Self {
        Self {
            version: 1,
            updated_at: Utc::now(),
            segment_duration_seconds,
            segments: Vec::new(),
        }
    }

    pub fn add_segment(&mut self, segment: &Segment, etag: Option<String>) -> bool {
        if self
            .segments
            .iter()
            .any(|existing| existing.sequence == segment.sequence)
        {
            return false;
        }

        self.segments.push(ManifestSegment {
            sequence: segment.sequence,
            starts_at: segment.starts_at,
            duration_seconds: segment.duration_seconds,
            key: segment.key.clone(),
            etag,
        });
        self.segments
            .sort_by(|left, right| left.sequence.cmp(&right.sequence));
        self.updated_at = Utc::now();

        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestSegment {
    pub sequence: i64,
    pub starts_at: DateTime<Utc>,
    pub duration_seconds: u32,
    pub key: String,
    pub etag: Option<String>,
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::config::SegmentConfig;

    #[test]
    fn manifest_deduplicates_segments_by_sequence() {
        let config = SegmentConfig::default();
        let segment = Segment::for_time(&config, "live/demo", Utc::now());
        let mut manifest = StreamManifest::new(config.duration_seconds);

        assert!(manifest.add_segment(&segment, Some("etag".to_string())));
        assert!(!manifest.add_segment(&segment, Some("etag".to_string())));
        assert_eq!(manifest.segments.len(), 1);
    }
}
