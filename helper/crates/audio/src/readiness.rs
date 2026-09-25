//! macOS capture-readiness decision, kept platform-neutral so the permission
//! matrix (mic denied vs screen denied vs BlackHole missing) is unit-tested on
//! any host. The macOS adapter only supplies the raw observations, gathered
//! with read-only calls (`CGPreflightScreenCaptureAccess`,
//! `AVCaptureDevice.authorizationStatus`) that never show a prompt.

use crate::{capture_ready, PermissionState};

pub const BLACKHOLE_DOWNLOAD_URL: &str = "https://existential.audio/blackhole/";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
pub struct MacosObservations {
    pub microphone_permission: PermissionState,
    /// `CGPreflightScreenCaptureAccess()`; it cannot distinguish "never asked"
    /// from "denied", so this is a plain bool.
    pub screen_access_granted: bool,
    pub blackhole_installed: bool,
    pub microphone_device_present: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosReadiness {
    pub driver: &'static str,
    pub native_loopback: bool,
    pub virtual_device_fallback: bool,
    pub driver_installed: bool,
    pub permission_required: bool,
    pub ready: bool,
    pub guidance: String,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_readiness(observed: MacosObservations) -> MacosReadiness {
    let mic_blocked = matches!(
        observed.microphone_permission,
        PermissionState::Denied | PermissionState::Restricted
    );
    let native_loopback = observed.screen_access_granted;
    let virtual_device_fallback = !native_loopback && observed.blackhole_installed;
    let speaker_route = native_loopback || virtual_device_fallback;
    // Without native access and without BlackHole the only fix that needs the
    // user is granting Screen Recording (or installing BlackHole).
    let screen_blocks = !speaker_route;
    let permission_required = mic_blocked || screen_blocks;
    let ready = capture_ready(
        speaker_route,
        observed.microphone_device_present,
        speaker_route,
        true,
        permission_required,
    );

    let guidance = if observed.microphone_permission == PermissionState::Restricted {
        "Microphone access is blocked by a device policy on this Mac, so AI Notetaker cannot record your voice. Ask your administrator to allow it.".to_string()
    } else if observed.microphone_permission == PermissionState::Denied {
        "Microphone access is denied. Open System Settings > Privacy & Security > Microphone, turn on AI Notetaker, then check again.".to_string()
    } else if screen_blocks {
        format!(
            "Meeting audio cannot be captured yet: Screen Recording access is not granted (macOS uses it for system audio). Open System Settings > Privacy & Security > Screen & System Audio Recording and turn on AI Notetaker, or install BlackHole from {BLACKHOLE_DOWNLOAD_URL} as an alternative. macOS shows the Screen Recording prompt when you start recording."
        )
    } else if !observed.microphone_device_present {
        "No microphone was found. Connect or enable a microphone, then check again.".to_string()
    } else if native_loopback {
        let mut text = "Native ScreenCaptureKit system-audio capture is ready. Keep your meeting app on its normal microphone and speaker.".to_string();
        if observed.microphone_permission == PermissionState::NotDetermined {
            text.push_str(" macOS will ask for microphone access when recording starts.");
        }
        text
    } else {
        let mut text = format!(
            "BlackHole fallback is available. Create a Multi-Output Device with BlackHole and your normal speakers or headphones so the meeting remains audible. Granting Screen Recording access switches to native capture without BlackHole. {BLACKHOLE_DOWNLOAD_URL}"
        );
        if observed.microphone_permission == PermissionState::NotDetermined {
            text.push_str(" macOS will ask for microphone access when recording starts.");
        }
        text
    };

    MacosReadiness {
        driver: if native_loopback {
            "ScreenCaptureKit"
        } else {
            "BlackHole"
        },
        native_loopback,
        virtual_device_fallback,
        driver_installed: speaker_route,
        permission_required,
        ready,
        guidance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(
        mic: PermissionState,
        screen: bool,
        blackhole: bool,
        mic_device: bool,
    ) -> MacosReadiness {
        macos_readiness(MacosObservations {
            microphone_permission: mic,
            screen_access_granted: screen,
            blackhole_installed: blackhole,
            microphone_device_present: mic_device,
        })
    }

    #[test]
    fn everything_granted_uses_native_loopback() {
        let r = observe(PermissionState::Granted, true, false, true);
        assert!(r.ready && r.native_loopback && !r.virtual_device_fallback);
        assert!(!r.permission_required);
        assert_eq!(r.driver, "ScreenCaptureKit");
    }

    #[test]
    fn mic_not_determined_is_ready_and_promises_a_prompt_on_start() {
        let r = observe(PermissionState::NotDetermined, true, false, true);
        assert!(r.ready && !r.permission_required);
        assert!(r.guidance.contains("ask for microphone access"));
    }

    #[test]
    fn mic_denied_blocks_even_with_working_system_audio() {
        let r = observe(PermissionState::Denied, true, true, true);
        assert!(!r.ready && r.permission_required);
        assert!(r.guidance.contains("Microphone"));
        assert!(!r.guidance.contains("Screen Recording"));
    }

    #[test]
    fn mic_restricted_is_reported_as_policy_block() {
        let r = observe(PermissionState::Restricted, true, false, true);
        assert!(!r.ready && r.permission_required);
        assert!(r.guidance.contains("policy"));
    }

    #[test]
    fn screen_denied_without_blackhole_asks_for_screen_access_or_blackhole() {
        let r = observe(PermissionState::Granted, false, false, true);
        assert!(!r.ready && r.permission_required && !r.driver_installed);
        assert!(r.guidance.contains("Screen Recording"));
        assert!(r.guidance.contains(BLACKHOLE_DOWNLOAD_URL));
        assert!(!r.guidance.contains("Microphone access is denied"));
    }

    #[test]
    fn screen_denied_with_blackhole_falls_back_and_stays_ready() {
        let r = observe(PermissionState::Granted, false, true, true);
        assert!(r.ready && !r.permission_required);
        assert!(r.virtual_device_fallback && !r.native_loopback);
        assert_eq!(r.driver, "BlackHole");
    }

    #[test]
    fn missing_microphone_device_is_not_a_permission_problem() {
        let r = observe(PermissionState::Granted, true, false, false);
        assert!(!r.ready && !r.permission_required);
        assert!(r.guidance.contains("No microphone"));
    }
}
