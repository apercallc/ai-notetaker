//! Pure device-name matching logic, kept separate from the actual cpal
//! device enumeration so it's testable without real audio hardware.

/// The device name (or name substring) each platform's virtual audio
/// driver exposes once installed. Matching is case-insensitive substring
/// matching because these names vary slightly by driver version
/// (e.g. "BlackHole 2ch" vs "BlackHole 16ch" if a user has a non-default
/// BlackHole variant installed).
pub const MACOS_DEVICE_HINT: &str = "blackhole";
pub const WINDOWS_DEVICE_HINT: &str = "cable";
pub const LINUX_DEVICE_HINT: &str = "notetaker";

/// Finds the first device name in `available` that matches `hint`
/// (case-insensitive substring). Returns `None` if the driver isn't
/// installed/selectable yet.
pub fn find_matching_device<'a>(available: &'a [String], hint: &str) -> Option<&'a str> {
    let hint_lower = hint.to_lowercase();
    available
        .iter()
        .find(|name| name.to_lowercase().contains(&hint_lower))
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_device_case_insensitively() {
        let devices = vec![
            "Built-in Microphone".to_string(),
            "BlackHole 2ch".to_string(),
        ];
        assert_eq!(
            find_matching_device(&devices, MACOS_DEVICE_HINT),
            Some("BlackHole 2ch")
        );
    }

    #[test]
    fn returns_none_when_driver_not_installed() {
        let devices = vec![
            "Built-in Microphone".to_string(),
            "Built-in Output".to_string(),
        ];
        assert_eq!(find_matching_device(&devices, MACOS_DEVICE_HINT), None);
    }

    #[test]
    fn matches_vb_cable_output_device_name() {
        let devices = vec!["CABLE Output (VB-Audio Virtual Cable)".to_string()];
        assert_eq!(
            find_matching_device(&devices, WINDOWS_DEVICE_HINT),
            Some("CABLE Output (VB-Audio Virtual Cable)")
        );
    }

    #[test]
    fn matches_first_hit_when_multiple_variants_present() {
        let devices = vec!["BlackHole 16ch".to_string(), "BlackHole 2ch".to_string()];
        assert_eq!(
            find_matching_device(&devices, MACOS_DEVICE_HINT),
            Some("BlackHole 16ch")
        );
    }
}
