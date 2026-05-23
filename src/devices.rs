use std::fmt;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKind {
    Audio,
    Video,
}

impl fmt::Display for DeviceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DeviceKind::Audio => f.write_str("audio"),
            DeviceKind::Video => f.write_str("video"),
        }
    }
}

#[derive(Debug)]
pub struct InputDevice {
    pub kind: DeviceKind,
    pub id: String,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Default)]
pub struct DeviceList {
    pub audio: Vec<InputDevice>,
    pub video: Vec<InputDevice>,
    pub warnings: Vec<String>,
}

pub fn list_inputs() -> DeviceList {
    list_ffmpeg_avfoundation_devices()
}

pub fn print_device_list(devices: &DeviceList) {
    println!("Audio inputs:");
    print_devices(&devices.audio);
    println!();
    println!("Video inputs:");
    print_devices(&devices.video);

    if !devices.warnings.is_empty() {
        println!();
        println!("Warnings:");
        for warning in &devices.warnings {
            println!("  - {warning}");
        }
    }
}

fn print_devices(devices: &[InputDevice]) {
    if devices.is_empty() {
        println!("  none found");
        return;
    }

    for device in devices {
        println!(
            "  [{}] {} ({}, source: {})",
            device.id, device.name, device.kind, device.source
        );
    }
}

fn list_ffmpeg_avfoundation_devices() -> DeviceList {
    let output = match Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
        ])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return DeviceList {
                warnings: vec![format!(
                    "macOS input discovery requires ffmpeg on PATH: {error}"
                )],
                ..DeviceList::default()
            };
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut devices = parse_ffmpeg_avfoundation_devices(&stderr);

    if devices.audio.is_empty() {
        devices
            .warnings
            .push("ffmpeg returned no AVFoundation audio inputs".to_string());
    }

    if devices.video.is_empty() {
        devices
            .warnings
            .push("ffmpeg returned no AVFoundation video inputs".to_string());
    }

    devices
}

fn parse_ffmpeg_avfoundation_devices(output: &str) -> DeviceList {
    let mut section = None;
    let mut devices = DeviceList::default();

    for line in output.lines() {
        if line.contains("AVFoundation video devices") {
            section = Some(DeviceKind::Video);
            continue;
        }

        if line.contains("AVFoundation audio devices") {
            section = Some(DeviceKind::Audio);
            continue;
        }

        let Some(kind) = section else {
            continue;
        };

        if let Some((id, name)) = parse_bracketed_device_line(line) {
            let device = InputDevice {
                kind,
                id,
                name,
                source: "ffmpeg-avfoundation".to_string(),
            };

            match kind {
                DeviceKind::Audio => devices.audio.push(device),
                DeviceKind::Video => devices.video.push(device),
            }
        }
    }

    devices
}

fn parse_bracketed_device_line(line: &str) -> Option<(String, String)> {
    let bracket_start = line.rfind('[')?;
    let bracket_end = line[bracket_start..].find(']')? + bracket_start;
    let id = line[bracket_start + 1..bracket_end].trim();
    let name = line[bracket_end + 1..].trim();

    if id.is_empty() || name.is_empty() || !id.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }

    Some((id.to_string(), name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_avfoundation_audio_and_video_sections() {
        let output = r#"
[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] [1] OBS Virtual Camera
[AVFoundation indev @ 0x123] AVFoundation audio devices:
[AVFoundation indev @ 0x123] [0] MacBook Pro Microphone
[in#0 @ 0x123] Error opening input: Input/output error
"#;

        let devices = parse_ffmpeg_avfoundation_devices(output);

        assert_eq!(devices.video.len(), 2);
        assert_eq!(devices.video[0].id, "0");
        assert_eq!(devices.video[0].name, "FaceTime HD Camera");
        assert_eq!(devices.audio.len(), 1);
        assert_eq!(devices.audio[0].id, "0");
        assert_eq!(devices.audio[0].name, "MacBook Pro Microphone");
    }
}
