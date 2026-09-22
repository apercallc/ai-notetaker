# Accessibility review checklist

The extension and webapp use semantic headings, labeled controls, live status
regions, visible keyboard focus, dark-mode tokens, and reduced-motion rules.
The repository checks cover the high-risk interaction states, but a release
still needs a rendered screen-reader and keyboard pass on all three surfaces.

## Release review

- [ ] Keyboard-only pass through onboarding, settings, recording, history, and
      action-item flows.
- [ ] Screen-reader pass for live transcript updates, recording errors, audio
      readiness, and destructive actions.
- [ ] Contrast check for light/dark themes and disabled/error/warning states.
- [ ] Zoom and narrow-popup pass without clipping or loss of controls.
- [ ] Native tray menu review on macOS, Windows, and Linux.

Automated tests and source review are not a substitute for that rendered pass;
record the browser/OS and tool used when it is completed.
