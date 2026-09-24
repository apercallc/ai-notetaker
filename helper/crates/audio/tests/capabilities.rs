use notetaker_audio::capture_ready;

/// These cases model the capability states returned by the three native
/// adapters. They deliberately do not require a microphone, monitor source,
/// ScreenCaptureKit permission, or WASAPI endpoint on the test host.
#[test]
fn native_loopback_is_ready_only_with_mic_and_permission() {
    assert!(capture_ready(true, true, true, true, false));
    assert!(!capture_ready(true, true, true, true, true));
}

#[test]
fn virtual_fallback_requires_both_routes() {
    assert!(capture_ready(true, true, true, true, false));
    assert!(!capture_ready(true, true, true, false, false));
    assert!(!capture_ready(true, true, false, true, false));
}

#[test]
fn missing_monitor_or_microphone_fails_closed() {
    assert!(!capture_ready(false, true, false, false, false));
    assert!(!capture_ready(true, false, true, true, false));
}
