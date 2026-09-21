---
name: notetaker-design-review
description: Review AI Notetaker UI, tray menus, packaging copy, accessibility, and interaction states for clarity, deference, depth, and native surface fit.
---

# AI Notetaker design review

Review the actual changed surface. For the extension, check small-popup
clarity, keyboard and screen-reader behavior, contrast, dark mode, and
reduced motion. For the Tauri tray, check native OS conventions: macOS menu
bar behavior, Windows tray behavior, and Linux desktop conventions. For the
webapp, check scanability and authenticated empty/loading/error states.

Flag specific file/line fixes for ambiguous labels, unnecessary chrome,
missing state feedback, inaccessible controls, or misleading packaging and
driver copy. Do not claim a visual issue is verified without a rendered/live
pass; state what still needs browser or OS confirmation.
