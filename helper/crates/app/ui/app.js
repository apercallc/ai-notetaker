(() => {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  const state = { page: "record", snapshot: null, detail: null, detailError: null, selectedId: null, currentFolderId: null, busy: false, recordTitle: "", notesQuery: "", notesPageLimit: 100, recordConsentAcknowledged: false, finalizingMeetingIds: new Set(), recoveringIds: new Set(), reprocessingIds: new Set(), settingsDirty: false, settingsOpen: {}, syncInProgress: false, syncRunId: null, finishedSyncRuns: [], syncAnnouncement: "", noticeTimer: 0, noticeKind: "", noticeSource: "", syncWarning: "" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const prettyDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  };
  const prettySegmentTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  };
  const DEFAULT_WEBAPP_URL = "https://ai-notetaker.apercallc.com";
  const providerName = (id) => ({ deepgram: "Deepgram", groq: "Groq", claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek" })[id] || id;
  const PLAN_NAMES = { free: "Free", local: "Free", hosted_trial: "Free", pro: "Pro", hosted_pro: "Pro", team: "Team", hosted_team: "Team" };
  const planName = (id) => PLAN_NAMES[id] || "Free";
  // Sync is a Pro/Team feature. Prefer the live answer from the plan overview, then what the
  // service said at sign-in, then a 402 the sync worker recorded.
  const syncNeedsPlan = (settings, sync) => {
    const live = accountState.overview?.entitlements;
    if (live && typeof live.canSync === "boolean") return !live.canSync;
    if (settings.preferences.hostedAccount?.syncAllowed === false) return true;
    return /HTTP 402/.test(sync?.lastError || "");
  };
  const processingReady = (settings) => providerKeySaved(settings, settings.preferences.transcriptionProvider) && providerKeySaved(settings, settings.preferences.summarizationProvider);
  const providerKeySaved = (settings, id) => settings[{ deepgram: "hasDeepgramKey", groq: "hasGroqKey", claude: "hasClaudeKey", gemini: "hasGeminiKey", deepseek: "hasDeepseekKey" }[id]];
  const meetingModeName = (id) => ({ general: "General", standup: "Stand-up", sales: "Sales", one_on_one: "1:1", interview: "Interview", lecture: "Lecture", custom: "Custom" })[id] || id;
  const platformName = (id) => ({ macos: "macOS", windows: "Windows", linux: "Linux" })[id] || id;

  // Errors are announced assertively (role="alert"), stay until dismissed or replaced by a newer
  // message, and are never timed out; other notices clear themselves. `passive` notices come from
  // render() and must not replace a message the person has not read yet.
  function notify(message, kind = "", { passive = false, source = "" } = {}) {
    const box = $("#notice");
    if (passive && state.noticeKind === "error" && !box.hidden) return;
    clearTimeout(state.noticeTimer);
    state.noticeKind = message ? kind : "";
    state.noticeSource = message ? source : "";
    box.textContent = "";
    box.className = `notice ${kind}`.trim();
    box.setAttribute("role", kind === "error" ? "alert" : "status");
    box.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    box.hidden = !message;
    if (!message) return;
    const text = document.createElement("span");
    text.textContent = message;
    box.append(text);
    if (kind === "error") {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "notice-dismiss";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => notify(""));
      box.append(dismiss);
    } else {
      state.noticeTimer = setTimeout(() => { box.hidden = true; state.noticeKind = ""; }, 6500);
    }
  }

  function setTopbarStatus(label, dotClass = "") {
    const status = $("#topbar-status");
    const nextDotClass = `status-dot ${dotClass}`.trim();
    if (status.dataset.label === label && status.dataset.dotClass === nextDotClass) return;
    status.dataset.label = label;
    status.dataset.dotClass = nextDotClass;
    status.innerHTML = `<span class="${nextDotClass}" aria-hidden="true"></span><span>${esc(label)}</span>`;
  }

  let refreshTask = null;
  let refreshQueued = false;
  let refreshForced = false;
  let renderedDataKey = "";
  let refreshFailing = false;
  let elapsedTimer = 0;
  // Background refreshes (the poll and sync status events) pass `passive`: when nothing on screen
  // changed they skip re-rendering, so a transcript being read is not rebuilt and scrolled to the top.
  function refresh(options) {
    if (document.visibilityState === "hidden") return Promise.resolve();
    if (!options?.passive) refreshForced = true;
    refreshQueued = true;
    if (refreshTask) return refreshTask;
    refreshTask = (async () => {
      try {
        while (refreshQueued && document.visibilityState !== "hidden") {
          refreshQueued = false;
          const force = refreshForced;
          refreshForced = false;
          await refreshSnapshot(force);
        }
      } finally {
        refreshTask = null;
      }
    })();
    return refreshTask;
  }

  async function refreshSnapshot(force = true) {
    try {
      state.snapshot = await invoke("desktop_snapshot");
      refreshFailing = false;
      if (state.noticeSource === "refresh") notify("");
      for (const meetingId of state.finalizingMeetingIds) {
        const meeting = state.snapshot.meetings.find((item) => item.id === meetingId);
        if (!meeting || meeting.status !== "recording") state.finalizingMeetingIds.delete(meetingId);
      }
      // Sign-in fields do not mark the form dirty, but rebuilding the page would wipe a password
      // or code being typed.
      if (state.page === "settings" && (state.settingsDirty || $("#hosted-password")?.value || $("#hosted-code")?.value)) return;
      if (state.page === "notes" && ($("#new-folder-form:not([hidden])") || $("#folder-manage:not([hidden])")
        || document.activeElement?.id === "note-folder")) return;
      if (state.selectedId && state.page === "notes") await loadDetail(state.selectedId, false);
      const dataKey = JSON.stringify([state.page, state.selectedId, state.currentFolderId, state.snapshot, state.detail, state.detailError]);
      if (!force && dataKey === renderedDataKey) return;
      renderedDataKey = dataKey;
      const focused = document.activeElement;
      const focusedId = focused?.id || null;
      const selection = focusedId && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
      render();
      if (focusedId) {
        const replacement = document.getElementById(focusedId);
        replacement?.focus({ preventScroll: true });
        if (selection && selection.every(Number.isInteger)) replacement?.setSelectionRange(...selection);
      }
    } catch (error) {
      if (state.snapshot) {
        // Keep what is on screen (a live recording's controls above all) and say the refresh failed,
        // once per outage rather than on every poll.
        console.error("Status refresh failed", error);
        if (!refreshFailing) notify("Couldn't update the latest status. Your recording and notes are safe.", "error", { source: "refresh" });
        refreshFailing = true;
        return;
      }
      $("#content").innerHTML = `<div class="empty-state" role="alert"><strong>AI Notetaker could not open your notes</strong><p>${esc(error)}</p><p>Your recordings are still saved on this device. Try again, or restart the app.</p><button type="button" class="secondary-button" id="retry-load">Try again</button></div>`;
      $("#retry-load")?.addEventListener("click", refresh);
      setTopbarStatus("Workspace unavailable", "needs-attention");
    }
  }

  function setPage(page) {
    if (state.page === "settings" && page !== "settings" && state.settingsDirty
      && !window.confirm("Discard unsaved settings changes?")) return;
    if (state.page !== page) {
      state.settingsDirty = false;
      state.recordConsentAcknowledged = false;
    }
    state.page = page;
    state.detail = null;
    state.detailError = null;
    render();
    if (page === "notes" && state.selectedId) void loadDetail(state.selectedId);
  }

  const ICONS = {
    "record": "<path d=\"M12 19v3\"/><path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"/><rect x=\"9\" y=\"2\" width=\"6\" height=\"13\" rx=\"3\"/>",
    "notes": "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\"/>",
    "actions": "<path d=\"M21 10.656V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12.344\"/><path d=\"m9 11 3 3L22 4\"/>",
    "ask": "<path d=\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\"/>",
    "team": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><path d=\"M16 3.128a4 4 0 0 1 0 7.744\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/>",
    "plans": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"5\" rx=\"2\"/><line x1=\"2\" x2=\"22\" y1=\"10\" y2=\"10\"/><path d=\"M6 14h2\"/>",
    "speaker": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/><path d=\"M16 9a5 5 0 0 1 0 6\"/><path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"/>",
    "info": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4\"/><path d=\"M12 8h.01\"/>",
    "settings": "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>"
  };

  const icon = (name) => `<svg class="ui-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">${ICONS[name]}</svg>`;

  // Same names, order and icons as the web app's navigation. Record is the one desktop-only item;
  // Team and Plan appear once you are signed in to an account (as on the web).
  const ACCOUNT_PAGES = ["actions", "team", "plans"];
  const isAccountPage = () => ACCOUNT_PAGES.includes(state.page);
  function navItems() {
    const signedIn = hostedSignedIn();
    const owner = accountState.overview?.account.role === "owner";
    return [
      ["record", "Record"],
      ["notes", "Library"],
      ["actions", "Actions"],
      ...(signedIn && owner ? [["team", "Team"]] : []),
      ...(signedIn ? [["plans", "Plan"]] : []),
      ["settings", "Settings"],
    ];
  }
  function renderNav(setupNeeded) {
    const items = navItems();
    const recording = Boolean(state.snapshot?.activeMeetingId);
    $("#nav-list").innerHTML = items.map(([id, label]) => `<button class="nav-button ${state.page === id ? "active" : ""} ${id === "record" && recording ? "is-recording" : ""}" type="button" data-page="${id}" aria-label="${id === "settings" && setupNeeded ? `${label} (setup needed)` : label}" ${state.page === id ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${ICONS[id]}</svg></span><span>${label}</span>${id === "settings" ? `<span class="nav-dot" id="settings-nav-dot" aria-hidden="true" ${setupNeeded ? "" : "hidden"}></span>` : ""}</button>`).join("");
    for (const button of document.querySelectorAll(".nav-button")) button.addEventListener("click", () => setPage(button.dataset.page));
  }

  function setHeader(title, eyebrow) {
    $("#page-title").textContent = title;
    $("#page-eyebrow").textContent = eyebrow;
  }

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    clearInterval(elapsedTimer);
    $("#app-version").textContent = `Version ${snapshot.version}`;
    const recording = Boolean(snapshot.activeMeetingId);
    const preferences = snapshot.settings.preferences;
    const providersReady = processingReady(snapshot.settings);
    const appReady = !snapshot.credentialStoreError && providersReady;
    const processing = snapshot.meetings.some((meeting) => meeting.status === "processing");
    const finalizing = snapshot.meetings.some((meeting) => state.finalizingMeetingIds.has(meeting.id) && meeting.status === "recording");
    const audioChecking = snapshot.audio.checking;
    const needsAttention = !recording && !processing && !finalizing && (!appReady || (!audioChecking && !snapshot.audio.ready));
    setTopbarStatus(
      recording ? "Recording" : finalizing ? "Finishing saved audio" : processing ? "Preparing saved notes" : !appReady ? "Setup needed" : audioChecking ? snapshot.audio.timedOut ? "Audio check taking longer" : "Checking audio" : snapshot.audio.ready ? "Ready to record" : snapshot.audio.permissionRequired ? "Audio permission needed" : "Audio setup needed",
      recording ? "recording" : needsAttention ? "needs-attention" : "",
    );
    $("#open-webapp").hidden = !snapshot.settings.preferences.webappUrl;
    if (hostedSignedIn() && !accountState.overview && !accountState.loading && !accountState.error) void loadOverview();
    state.setupNeeded = !appReady;
    if (snapshot.webappSync.configured) state.syncWarning = "";
    renderNav(state.setupNeeded);
    if (snapshot.credentialStoreError) notify(snapshot.credentialStoreError, "error", { passive: true });
    else if (snapshot.unreadableRecordings) notify(`${snapshot.unreadableRecordings} recording${snapshot.unreadableRecordings === 1 ? "" : "s"} could not be read. Other notes remain available.`, "warn", { passive: true });
    try {
      if (state.page === "record") renderRecord();
      else if (state.page === "notes") renderNotes();
      else if (isAccountPage()) renderAccount();
      else renderSettings();
    } catch (error) {
      console.error("Page render failed", state.page, error);
      $("#content").innerHTML = '<div class="empty-state"><strong>This page could not be displayed</strong><p>Return to this page or restart the app. Your local notes remain saved.</p></div>';
    }
  }

  function renderRecord() {
    setHeader("Record a meeting", "Capture your microphone and the meeting audio on this device.");
    const s = state.snapshot;
    const active = s.activeMeetingId;
    const audio = s.audio;
    const keyReady = processingReady(s.settings);
    const setup = s.credentialStoreError || !keyReady;
    const ownKeysMessage = `Add a ${providerName(s.settings.preferences.transcriptionProvider)} key for transcripts and a ${providerName(s.settings.preferences.summarizationProvider)} key for summaries. Keys stay in this device's credential store.`;
    const setupMessage = s.credentialStoreError || ownKeysMessage;
    const startHint = recordingStartHint({
      credentialStoreError: s.credentialStoreError,
      keyReady,
      transcriptionProvider: s.settings.preferences.transcriptionProvider,
      summarizationProvider: s.settings.preferences.summarizationProvider,
      audio,
      consentAcknowledged: state.recordConsentAcknowledged,
      busy: state.busy,
      audioChecking: audio.checking,
      audioTimedOut: audio.timedOut,
    });
    if (!active) announceRecordingReadiness(startHint);
    const openAudioSettings = !audio.ready && !audio.checking
      ? `<button class="small-button" id="open-screen-recording-settings" data-pane="${permissionPane(audio)}">${audio.platform === "macos" ? (permissionPane(audio) === "microphone" ? "Open macOS microphone permission" : "Open macOS screen &amp; audio recording permission") : audio.platform === "windows" ? "Open Windows microphone settings" : "Open sound settings"}</button>`
      : "";
    const macAudioUnavailable = audio.platform === "macos" && audio.driver === "Unavailable";
    const audioGuidance = macAudioUnavailable
      ? `<div class="guidance"><p>Allow AI Notetaker under System Settings &gt; Privacy &amp; Security &gt; Screen &amp; System Audio Recording, then reopen the app. If it is not listed, add it from Applications.</p><details class="audio-fallback"><summary>Use BlackHole instead</summary><p>BlackHole is an optional fallback and is not included with AI Notetaker. After installing it, create a Multi-Output Device with BlackHole and your speakers or headphones, then select it as the meeting app’s speaker. <button class="small-button" id="open-blackhole-download">Download BlackHole from Existential Audio</button></p></details></div>`
      : `<p class="guidance">${esc(audio.guidance || "Audio will be captured from your current microphone and system output.")}</p>`;
    const recent = s.meetings.slice(0, 3);
    const recoverable = s.meetings.find((meeting) => meeting.status === "recovered" && !meeting.textOnlyImport);
    const processing = s.meetings.filter((meeting) => meeting.status === "processing").length;
    const finalizing = s.meetings.some((meeting) => state.finalizingMeetingIds.has(meeting.id) && meeting.status === "recording");
    $("#content").innerHTML = `
      ${setup ? `<div class="setup-callout">${icon("info")}<div><strong>${s.credentialStoreError ? "Secure credential storage is unavailable" : "Finish setup to record"}</strong><span>${esc(setupMessage)}</span>${s.credentialStoreError ? `<button class="small-button" id="retry-credential-store">Try again</button>` : `<button class="small-button" id="goto-providers">Add API keys</button>`}</div></div>` : ""}
      ${recoverable ? `<div class="setup-callout">${icon("info")}<div><strong>Interrupted recording</strong><span>${esc(`"${recoverable.title}" stopped unexpectedly. Its audio is saved on this device.`)}</span><button class="small-button" id="open-recoverable">Finish notes</button></div></div>` : ""}
      ${processing ? `<p class="process-status" role="status">Preparing notes from ${processing} saved recording${processing === 1 ? "" : "s"}. You can keep using the app.</p>` : ""}
      ${finalizing ? '<p class="process-status">Finishing saved audio. It stays on this device while notes are prepared.</p>' : ""}
      <div class="record-grid">
        <section class="card record-card" aria-labelledby="record-heading">
          <div class="record-intro"><h2 id="record-heading">${active ? "Recording is in progress" : "Start a recording"}</h2><p>${active ? "Audio is being saved on this device while your notes are prepared." : "Record Google Meet, Teams, Zoom, Discord, or Slack calls in a browser or desktop app."}</p></div>
          <label class="field-label" for="meeting-title">Meeting title <span class="fine-print">(optional)</span></label>
          <input id="meeting-title" class="text-input" maxlength="200" value="${esc(state.recordTitle)}" placeholder="e.g. Product planning" ${active ? "disabled" : ""} />
          <label class="consent-row"><input id="record-consent" type="checkbox" ${state.recordConsentAcknowledged ? "checked" : ""} ${active ? "disabled" : ""} /><span>I’ve told everyone on the call that recording is starting.</span></label>
          <div class="record-actions">${active
            ? `<button class="danger-button" id="stop-recording"><span class="record-icon" aria-hidden="true"></span>Stop recording</button><span class="fine-print recording-elapsed" id="recording-elapsed" aria-hidden="true"></span>`
            : `<button class="primary-button" id="start-recording" aria-describedby="start-recording-hint" ${!state.recordConsentAcknowledged || !audio.ready || !keyReady || s.credentialStoreError || state.busy ? "disabled" : ""}><span class="record-icon" aria-hidden="true"></span>Start recording</button><span class="fine-print" id="start-recording-hint">${esc(startHint)}</span>`}
          </div>
        </section>
        <details class="card audio-card" ${audio.ready && !audio.checking ? "" : "open"}>
          <summary class="audio-card-head"><h2 id="audio-heading">Audio setup</h2><span class="readiness ${audio.checking ? "checking" : audio.ready ? "" : "warn"}">${audio.checking ? audio.timedOut ? "Check taking longer" : "Checking audio" : audio.ready ? "Ready" : audio.permissionRequired ? "Permission needed" : "Check setup"}</span></summary>
          <div class="device-list">
            <div class="device-row"><span class="device-icon">${icon("record")}</span><div><strong>Microphone</strong><span>${esc(audio.microphone || "Default microphone")}</span></div></div>
            <div class="device-row"><span class="device-icon">${icon("speaker")}</span><div><strong>System audio</strong><span>${esc(audio.speaker || "Default output")}</span></div></div>
            ${audio.ready ? "" : `<div class="device-row"><span class="device-icon">${icon("settings")}</span><div><strong>Capture method</strong><span>${esc(audio.driver)}</span></div></div>`}
          </div>
          ${audioGuidance}
          <p class="guidance">System audio can include other apps and notifications. Keep unrelated audio quiet during the call.</p>
          <div class="audio-actions">${openAudioSettings}<button class="small-button" id="check-audio">Check audio again</button></div>
        </details>
      </div>
      <div class="section-heading"><div><h2>Recent notes</h2></div><button class="small-button" id="all-notes">View all</button></div>
      ${recent.length ? `<div class="recent-list">${recent.map((meeting) => meetingCard(meeting)).join("")}</div>` : `<div class="empty-state"><strong>No recordings yet</strong><p>Start a recording above. Its transcript and notes will appear here.</p></div>`}`;
    $("#record-consent")?.addEventListener("change", () => {
      state.recordConsentAcknowledged = $("#record-consent").checked;
      const startButton = $("#start-recording");
      if (startButton) startButton.disabled = !state.recordConsentAcknowledged || !audio.ready || !keyReady || s.credentialStoreError || state.busy;
      const hint = $("#start-recording-hint");
      if (hint) hint.textContent = recordingStartHint({
        credentialStoreError: s.credentialStoreError,
        keyReady,
        transcriptionProvider: s.settings.preferences.transcriptionProvider,
        summarizationProvider: s.settings.preferences.summarizationProvider,
        audio,
        consentAcknowledged: state.recordConsentAcknowledged,
        busy: state.busy,
        audioChecking: audio.checking,
        audioTimedOut: audio.timedOut,
      });
      if (hint) announceRecordingReadiness(hint.textContent);
    });
    $("#meeting-title")?.addEventListener("input", (event) => { state.recordTitle = event.currentTarget.value; });
    const startedAt = Date.parse(s.meetings.find((meeting) => meeting.id === active)?.startedAt);
    if (active && Number.isFinite(startedAt)) {
      const tick = () => {
        const label = $("#recording-elapsed");
        if (!label) { clearInterval(elapsedTimer); return; }
        const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        const [h, m, sec] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
        label.textContent = `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(sec).padStart(2, "0")}`;
      };
      tick();
      elapsedTimer = setInterval(tick, 1000);
    }
    $("#open-recoverable")?.addEventListener("click", () => openMeeting(recoverable.id));
    $("#start-recording")?.addEventListener("click", startRecording);
    $("#stop-recording")?.addEventListener("click", stopRecording);
    $("#check-audio")?.addEventListener("click", checkAudio);
    $("#open-screen-recording-settings")?.addEventListener("click", openScreenRecordingSettings);
    $("#open-blackhole-download")?.addEventListener("click", async () => {
      try { await invoke("desktop_open_blackhole_download"); }
      catch (error) { notify(String(error), "error"); }
    });
    $("#all-notes")?.addEventListener("click", () => setPage("notes"));
    $("#retry-credential-store")?.addEventListener("click", () => void refresh());
    $("#goto-providers")?.addEventListener("click", () => { state.settingsOpen.providers = true; setPage("settings"); requestAnimationFrame(() => $("#settings-providers h2")?.focus({ preventScroll: false })); });
    for (const button of document.querySelectorAll("[data-meeting-id]")) button.addEventListener("click", () => openMeeting(button.dataset.meetingId));
  }

  function meetingCard(meeting) {
    const preview = state.finalizingMeetingIds.has(meeting.id) ? "Finishing saved audio" : meeting.summary || (meeting.actionItems.length ? meeting.actionItems.map((item) => item.text).join(" · ") : statusLabel(meeting.status));
    return `<button class="meeting-card" data-meeting-id="${esc(meeting.id)}"><strong>${esc(meeting.title)}</strong><time>${esc(prettyDate(meeting.startedAt))}</time><span class="preview">${esc(preview)}</span></button>`;
  }

  function recordingStartHint({ credentialStoreError, keyReady, audio, consentAcknowledged, busy, audioChecking, audioTimedOut }) {
    if (busy) return "Starting recording…";
    const nextSteps = [];
    if (credentialStoreError) nextSteps.push("Follow the secure storage instructions above, then retry saving your keys in Settings.");
    else if (!keyReady) nextSteps.push("Add your provider keys in Settings.");
    if (!audio.ready) {
      nextSteps.push(audioChecking
        ? audioTimedOut ? "The audio check is taking longer than usual. Follow the Audio setup steps."
          : "Wait for the audio check to finish."
        : "Complete Audio setup.");
    }
    if (!consentAcknowledged) nextSteps.push("Confirm you’ve told everyone recording is starting.");
    return nextSteps.length
      ? `To record: ${nextSteps.join(" ")}`
      : "Microphone and meeting audio are ready.";
  }

  function announceRecordingReadiness(message) {
    const status = $("#recording-readiness-status");
    if (status && status.textContent !== message) status.textContent = message;
  }

  function statusLabel(status) { return ({ recording: "Recording", processing: "Preparing your notes…", recovered: "Interrupted", complete: "Notes ready", saved: "Audio only" })[status] || status; }

  async function startRecording() {
    if (!state.recordConsentAcknowledged || state.busy) return;
    const title = $("#meeting-title").value;
    const consent = state.recordConsentAcknowledged;
    state.busy = true;
    const button = $("#start-recording");
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Starting…"; }
    const hint = $("#start-recording-hint");
    if (hint) hint.textContent = "Starting recording…";
    notify("Starting recording…");
    try {
      await invoke("desktop_start_recording", { title, consentAcknowledged: consent });
      state.recordConsentAcknowledged = false;
      state.recordTitle = "";
      notify("Recording started. Audio is being saved on this device.");
    } catch (error) { notify(String(error), "error"); }
    finally { state.busy = false; await refresh(); }
  }

  async function stopRecording() {
    if (state.busy) return;
    const id = state.snapshot.activeMeetingId;
    if (!id) return;
    state.busy = true;
    state.finalizingMeetingIds.add(id);
    const button = $("#stop-recording");
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Stopping…"; }
    notify("Stopping recording… Audio is saved locally while notes are prepared.");
    try {
      await invoke("desktop_stop_recording", { meetingId: id });
      notify("Recording stopped. Your notes are being prepared from the saved audio.");
      await refresh();
    } catch (error) {
      state.finalizingMeetingIds.delete(id);
      notify(String(error), "error");
      await refresh();
    }
    finally {
      state.busy = false;
      if (button?.isConnected) button.disabled = false;
    }
  }

  async function checkAudio() {
    const button = $("#check-audio");
    if (button?.disabled) return;
    if (button) { button.disabled = true; button.textContent = "Checking…"; }
    try { await invoke("desktop_test_audio"); notify("Checking audio. This takes a few seconds."); setTimeout(refresh, 900); }
    catch (error) {
      notify(String(error), "error");
      if (button?.isConnected) { button.disabled = false; button.textContent = "Check audio again"; }
    }
  }

  // macOS keeps microphone and Screen & System Audio Recording in separate panes. No microphone
  // reported means the microphone permission is the missing one; otherwise it is loopback capture.
  function permissionPane(audio) {
    return audio.platform === "macos" && !audio.microphone ? "microphone" : "screen_capture";
  }

  async function openScreenRecordingSettings() {
    try {
      await invoke("desktop_open_screen_recording_settings", { pane: permissionPane(state.snapshot.audio) });
      notify(state.snapshot.audio.platform === "macos" ? "System Settings is open. Turn on AI Notetaker, reopen the app, then check audio again." : "Sound settings are open. Choose your microphone and output, then check audio again.");
    } catch (error) { notify(String(error), "error"); }
  }

  function renderNotes() {
    setHeader("Library", "Your notes, saved on this device.");
    const meetings = state.snapshot.meetings;
    const folders = state.snapshot.folders || [];
    const noteCounts = new Map();
    for (const meeting of meetings) {
      const folderId = meeting.folderId || null;
      noteCounts.set(folderId, (noteCounts.get(folderId) || 0) + 1);
    }
    if (state.currentFolderId && !folders.some((folder) => folder.id === state.currentFolderId)) state.currentFolderId = null;
    const current = folders.find((folder) => folder.id === state.currentFolderId);
    const directNoteCount = noteCounts.get(state.currentFolderId) || 0;
    const path = folderPath(state.currentFolderId);
    const listScroll = $("#meeting-list")?.scrollTop || 0;
    const previousDetail = $("#note-detail");
    const transcriptPosition = previousDetail && { meetingId: previousDetail.dataset.meetingId, scrollTop: $(".transcript-list", previousDetail)?.scrollTop || 0 };
    $("#content").innerHTML = `<div class="notes-layout">
      <section class="card notes-list-panel"><div class="panel-heading">
        ${state.snapshot.libraryError ? '<p class="library-error" role="alert">Folders could not be loaded. Your recordings are still available. Try restarting the app.</p>' : ""}
        <nav class="folder-breadcrumbs" aria-label="Folder path"><button type="button" data-folder-path="">Library</button>${path.map((folder) => `<span aria-hidden="true">/</span><button type="button" data-folder-path="${esc(folder.id)}" ${folder.id === state.currentFolderId ? 'aria-current="page"' : ""}>${esc(folder.name)}</button>`).join("")}</nav>
        <div class="library-heading"><h2>${esc(current?.name || "Library")} <span class="fine-print">${directNoteCount} ${directNoteCount === 1 ? "note" : "notes"}</span></h2><button type="button" class="small-button" id="new-folder">New folder</button></div>
        <form class="folder-form" id="new-folder-form" hidden><label class="field-label" for="folder-name">Folder name</label><div class="inline-actions"><input class="text-input" id="folder-name" maxlength="80" required /><button class="secondary-button" type="submit">Create</button><button class="small-button" type="button" id="cancel-folder">Cancel</button></div></form>
        ${current ? `<button type="button" class="small-button" id="manage-folder" aria-expanded="false" aria-controls="folder-manage">Manage this folder</button><div class="folder-manage" id="folder-manage" hidden><label class="field-label" for="rename-folder">Name</label><div class="inline-actions"><input class="text-input" id="rename-folder" maxlength="80" value="${esc(current.name)}" /><button type="button" class="small-button" id="apply-folder-name">Rename</button></div><label class="field-label" for="folder-parent">Move folder to</label><div class="inline-actions"><select class="select-input" id="folder-parent">${folderOptions(current.parentId, current.id)}</select><button type="button" class="small-button" id="apply-folder-parent">Move</button></div><button type="button" class="small-button folder-delete" id="delete-folder">Delete empty folder</button></div>` : ""}
        <input id="notes-search" class="search-input" type="search" value="${esc(state.notesQuery)}" placeholder="Search notes" aria-label="Search notes" />
        <p class="fine-print">${state.notesQuery ? "Search includes this folder and its subfolders." : "Browse folders or select a recording."}</p>
      </div><div id="meeting-list" class="meeting-list"></div></section>
      <section class="card note-detail" id="note-detail">${state.detailError ? `<div class="empty-state" role="alert"><strong>This note could not open</strong><p>${esc(state.detailError)}</p><p>Choose it again, or restart the app. Saved audio is not affected.</p></div>` : state.selectedId ? '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Opening note…</span></div>' : '<div class="empty-state"><strong>Select a note</strong><p>Its summary, action items and transcript appear here.</p></div>'}</section>
    </div>`;
    const search = $("#notes-search");
    search.addEventListener("input", () => { state.notesQuery = search.value; state.notesPageLimit = 100; renderMeetingList(state.notesQuery, noteCounts); });
    renderMeetingList(state.notesQuery, noteCounts);
    $("#meeting-list").scrollTop = listScroll;
    for (const button of document.querySelectorAll("[data-folder-path]")) button.addEventListener("click", () => openFolder(button.dataset.folderPath || null));
    $("#new-folder")?.addEventListener("click", () => { $("#new-folder-form").hidden = false; $("#folder-name").focus(); });
    const closeFolderForm = () => { $("#new-folder-form").hidden = true; $("#new-folder")?.focus(); };
    $("#cancel-folder")?.addEventListener("click", closeFolderForm);
    $("#new-folder-form")?.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closeFolderForm(); } });
    $("#new-folder-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector('button[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true;
      try { await invoke("desktop_create_folder", { parentId: state.currentFolderId, name: $("#folder-name").value }); $("#new-folder-form").hidden = true; notify("Folder created."); await refresh(); }
      catch (error) { notify(String(error), "error"); }
      finally { submit.disabled = false; }
    });
    $("#manage-folder")?.addEventListener("click", () => {
      const panel = $("#folder-manage");
      panel.hidden = !panel.hidden;
      $("#manage-folder").setAttribute("aria-expanded", String(!panel.hidden));
      if (panel.hidden) $("#manage-folder").focus();
    });
    $("#apply-folder-name")?.addEventListener("click", async () => {
      try { await invoke("desktop_rename_folder", { folderId: state.currentFolderId, name: $("#rename-folder").value }); $("#folder-manage").hidden = true; notify("Folder renamed."); await refresh(); }
      catch (error) { notify(String(error), "error"); }
    });
    $("#apply-folder-parent")?.addEventListener("click", async () => {
      try { await invoke("desktop_move_folder", { folderId: state.currentFolderId, parentId: $("#folder-parent").value || null }); $("#folder-manage").hidden = true; notify("Folder moved."); await refresh(); }
      catch (error) { notify(String(error), "error"); }
    });
    $("#delete-folder")?.addEventListener("click", async () => {
      if (!window.confirm("Delete this empty folder? Recordings are never deleted by this action.")) return;
      try { await invoke("desktop_delete_folder", { folderId: state.currentFolderId }); state.currentFolderId = current.parentId; state.selectedId = null; state.detail = null; notify("Empty folder deleted."); await refresh(); }
      catch (error) { notify(String(error), "error"); }
    });
    if (state.detail) renderDetail(state.detail, transcriptPosition);
  }

  function folderPath(id) {
    const folders = state.snapshot.folders || [];
    const path = [];
    const seen = new Set();
    for (let current = folders.find((folder) => folder.id === id); current && !seen.has(current.id); current = folders.find((folder) => folder.id === current.parentId)) {
      seen.add(current.id);
      path.unshift(current);
    }
    return path;
  }

  function folderOptions(selectedId, excludeId = null) {
    const folders = state.snapshot.folders || [];
    const excluded = new Set(excludeId ? [excludeId] : []);
    for (const folder of folders) if (excludeId && folderPath(folder.id).some((part) => part.id === excludeId)) excluded.add(folder.id);
    const options = folders.filter((folder) => !excluded.has(folder.id))
      .map((folder) => ({ id: folder.id, path: folderPath(folder.id).map((part) => part.name).join(" / ") }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
    return `<option value="" ${!selectedId ? "selected" : ""}>Library (top level)</option>${options.map((folder) => `<option value="${esc(folder.id)}" ${folder.id === selectedId ? "selected" : ""}>${esc(folder.path)}</option>`).join("")}`;
  }

  function openFolder(id) {
    state.currentFolderId = id;
    state.notesQuery = "";
    state.notesPageLimit = 100;
    state.selectedId = null;
    state.detail = null;
    state.detailError = null;
    renderNotes();
  }

  function renderMeetingList(query = "", noteCounts) {
    const list = $("#meeting-list");
    if (!list) return;
    const needle = query.trim().toLocaleLowerCase();
    const folders = state.snapshot.folders || [];
    const scope = new Set(state.currentFolderId ? [state.currentFolderId] : []);
    if (needle && state.currentFolderId) for (const folder of folders) if (folderPath(folder.id).some((part) => part.id === state.currentFolderId)) scope.add(folder.id);
    const filtered = state.snapshot.meetings.filter((meeting) =>
      (state.currentFolderId ? needle ? scope.has(meeting.folderId) : meeting.folderId === state.currentFolderId : needle || !meeting.folderId)
      && `${meeting.title} ${meeting.summary || ""}`.toLocaleLowerCase().includes(needle));
    const childFolders = needle ? [] : folders.filter((folder) => folder.parentId === state.currentFolderId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const folderRows = childFolders.map((folder) => { const count = noteCounts.get(folder.id) || 0; return `<button class="folder-list-item" data-open-folder="${esc(folder.id)}">${icon("notes")}<strong>${esc(folder.name)}</strong><span>${count} ${count === 1 ? "note" : "notes"}</span></button>`; }).join("");
    const visible = filtered.slice(0, state.notesPageLimit);
    const more = filtered.length > visible.length
      ? `<button class="load-more-meetings" type="button" id="load-more-meetings">Show more notes <span>${visible.length} of ${filtered.length}</span></button>`
      : "";
    list.innerHTML = folderRows + (visible.length ? visible.map((meeting) => `<button class="meeting-list-item ${meeting.id === state.selectedId ? "selected" : ""}" data-id="${esc(meeting.id)}"><strong>${esc(meeting.title)}</strong><span>${esc(prettyDate(meeting.startedAt))} · ${esc(statusLabel(meeting.status))}</span></button>`).join("") : !folderRows ? `<div class="empty-state">${state.snapshot.meetings.length ? needle ? "No notes match your search." : "This folder is empty. Move a note here from its Folder menu." : "No recordings yet. Notes appear here after you record a meeting."}</div>` : "") + more + `<span class="sr-only" role="status" aria-live="polite">Showing ${visible.length} of ${filtered.length} notes.</span>`;
    for (const button of list.querySelectorAll("[data-open-folder]")) button.addEventListener("click", () => openFolder(button.dataset.openFolder));
    for (const button of list.querySelectorAll("[data-id]")) button.addEventListener("click", () => openMeeting(button.dataset.id));
    $("#load-more-meetings", list)?.addEventListener("click", () => {
      const scrollTop = list.scrollTop;
      state.notesPageLimit += 100;
      renderMeetingList(state.notesQuery, noteCounts);
      list.scrollTop = scrollTop;
      const nextPageButton = $("#load-more-meetings", list);
      (nextPageButton || list.querySelector("[data-id]:last-of-type"))?.focus();
    });
  }

  async function openMeeting(id) {
    if (state.page === "settings" && state.settingsDirty && !window.confirm("Discard unsaved settings changes?")) return;
    if (state.page !== "notes") {
      state.recordConsentAcknowledged = false;
      state.notesQuery = "";
    }
    const meeting = state.snapshot.meetings.find((item) => item.id === id);
    if (meeting) state.currentFolderId = meeting.folderId || null;
    state.page = "notes";
    state.selectedId = id;
    state.detail = null;
    state.detailError = null;
    for (const button of document.querySelectorAll(".nav-button")) {
      const active = button.dataset.page === "notes";
      button.classList.toggle("active", active);
      active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
    }
    render();
    await loadDetail(id);
  }

  async function loadDetail(id, rerender = true) {
    try {
      const detail = await invoke("desktop_get_meeting", { meetingId: id });
      if (state.selectedId !== id || state.page !== "notes") return;
      state.detail = detail;
      state.detailError = null;
      if (rerender) renderDetail(detail);
    } catch (error) {
      if (state.selectedId !== id || state.page !== "notes") return;
      state.detail = null;
      state.detailError = String(error);
      if (rerender) renderNotes();
    }
  }


  // Same export formats as the web app's note page.
  function noteMarkdown(detail) {
    const m = detail.meeting;
    const items = (m.actionItems || []).map((item) => `- [${item.status === "done" ? "x" : " "}] ${item.text}${item.owner ? ` (${item.owner})` : ""}`);
    return [`# ${m.title}`, "", `Started: ${m.startedAt}`, ...(m.endedAt ? [`Ended: ${m.endedAt}`] : []), "", "## Summary", m.summary || "_No summary available._", "", "## Action Items", ...(items.length ? items : ["_None_"]), "", "## Transcript", ...detail.transcript.map((segment) => `**${segment.speaker}:** ${segment.text}`)].join("\n");
  }
  function notePlainText(detail) {
    const m = detail.meeting;
    const items = (m.actionItems || []).map((item) => `${item.status === "done" ? "[done]" : "[open]"} ${item.text}${item.owner ? ` (${item.owner})` : ""}`);
    return [m.title, `Started: ${m.startedAt}`, ...(m.endedAt ? [`Ended: ${m.endedAt}`] : []), "", "SUMMARY", m.summary || "No summary available.", "", "ACTION ITEMS", ...(items.length ? items : ["None"]), "", "TRANSCRIPT", ...detail.transcript.map((segment) => `${segment.speaker}: ${segment.text}`)].join("\n");
  }
  const exportName = (title, extension) => `${(title || "meeting").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "meeting"}.${extension}`;

  // `kept` carries the transcript scroll position across a re-render of the same note.
  function renderDetail(detail, kept = null) {
    const root = $("#note-detail");
    if (!root) return;
    const meeting = detail.meeting;
    const position = kept || { meetingId: root.dataset.meetingId, scrollTop: $(".transcript-list", root)?.scrollTop || 0 };
    const transcriptScroll = position.meetingId === meeting.id ? position.scrollTop : 0;
    const extensionStatusLabels = new Map([["recording", "in-progress"], ["saved", "audio-saved"], ["processing", "processing"], ["complete", "completed"], ["error", "failed"]]);
    const extensionStatusLabel = extensionStatusLabels.get(meeting.extensionSourceStatus) || "legacy";
    const importNotice = meeting.textOnlyImport
      ? `<p class="privacy-note">${detail.transcript.length ? `Imported ${esc(extensionStatusLabel)} meeting · transcript text only.` : "Imported meeting details; no transcript text had been saved yet."} Original recording remains in the extension.</p>`
      : meeting.reprocessedFrom
        ? `<p class="privacy-note">New desktop notes from imported extension audio. The original extension transcript and summary remain unchanged.</p>`
        : meeting.extensionSourceStatus
        ? `<p class="privacy-note">Imported ${esc(extensionStatusLabel)} extension recording · saved audio is stored on this device. The extension source remains unchanged.</p>`
        : "";
    root.innerHTML = `<div class="note-detail-head"><div><h2>${esc(meeting.title)}</h2><time>${esc(prettyDate(meeting.startedAt))}</time></div><span class="status-pill">${esc(statusLabel(meeting.status))}</span></div>
      <section class="note-section"><h3>Summary</h3><div class="summary-text">${esc(meeting.summary || (meeting.status === "recording" ? "Recording is in progress. Stop the recording to prepare your notes." : meeting.status === "saved" ? "No notes were made from this recording. Its audio is safe on this device." : "Summary is not available yet."))}</div></section>
      ${meeting.actionItems.length ? `<section class="note-section"><h3>Action items</h3><ul class="action-list">${meeting.actionItems.map((item) => `<li>${item.status === "done" ? `<span class="fine-print">Done · </span>` : ""}${esc(item.text)}${item.owner ? ` <span class="fine-print">— ${esc(item.owner)}</span>` : ""}</li>`).join("")}</ul></section>` : ""}
      <section class="note-section"><h3>Transcript</h3><div class="transcript-list">${detail.transcript.length ? detail.transcript.map((segment) => `<p class="transcript-item">${segment.timestamp ? `<time class="fine-print">${esc(prettySegmentTime(segment.timestamp))}</time> ` : ""}<strong>${esc(segment.speaker)}</strong>${esc(segment.text)}</p>`).join("") : '<p class="fine-print">Transcript is not available yet.</p>'}</div></section>
      ${importNotice}
      ${meeting.canReprocessExtensionAudio ? `<section class="recovery-actions"><p class="privacy-note">Create a separate desktop note from the saved audio. The imported transcript and summary will stay unchanged.</p><button class="secondary-button" id="reprocess-extension-audio" ${state.reprocessingIds.has(meeting.id) ? "disabled" : ""}>${state.reprocessingIds.has(meeting.id) ? "Preparing audio copy…" : "Create notes from saved audio"}</button></section>` : ""}
      ${meeting.status === "recovered" && !meeting.textOnlyImport ? `<section class="recovery-actions"><p class="privacy-note">Audio is safe on this device. Resume processing it to finish the transcript and notes.</p><button class="secondary-button" id="recover-meeting" ${state.recoveringIds.has(meeting.id) ? "disabled" : ""}>${state.recoveringIds.has(meeting.id) ? "Finishing notes…" : "Finish notes from saved audio"}</button></section>` : ""}
      <div class="note-actions"><div class="note-folder-control"><label class="field-label" for="note-folder">Folder</label><select class="select-input" id="note-folder">${folderOptions(meeting.folderId)}</select><button type="button" class="small-button" id="move-note">Move note</button></div><div class="inline-actions note-export"><button class="secondary-button" id="copy-note">Copy as Markdown</button><button class="secondary-button" id="save-note-md">Save Markdown</button><button class="secondary-button" id="save-note-txt">Save text</button></div><button type="button" class="secondary-button danger" id="delete-note">${meeting.textOnlyImport ? "Delete imported note" : "Delete recording"}</button></div>`;
    root.dataset.meetingId = meeting.id;
    const transcriptList = $(".transcript-list", root);
    if (transcriptList && transcriptScroll) transcriptList.scrollTop = transcriptScroll;
    $("#copy-note")?.addEventListener("click", async () => { try { await navigator.clipboard.writeText(noteMarkdown(detail)); notify("Copied to the clipboard."); } catch { notify("Could not copy. Use Save Markdown instead.", "error"); } });
    for (const [id, extension, build] of [["#save-note-md", "md", noteMarkdown], ["#save-note-txt", "txt", notePlainText]]) $(id)?.addEventListener("click", async () => { try { if (await invoke("desktop_save_text_file", { fileName: exportName(detail.meeting.title, extension), contents: build(detail) })) notify("Saved."); } catch (error) { notify(String(error), "error"); } });
    $("#delete-note")?.addEventListener("click", deleteMeeting);
    $("#recover-meeting")?.addEventListener("click", recoverMeeting);
    $("#reprocess-extension-audio")?.addEventListener("click", reprocessExtensionAudio);
    $("#move-note")?.addEventListener("click", async () => {
      const destination = $("#note-folder").value || null;
      if (destination === (meeting.folderId || null)) { notify("The note is already in that folder."); return; }
      const moveButton = $("#move-note");
      if (moveButton.disabled) return;
      moveButton.disabled = true;
      try {
        await invoke("desktop_move_meeting", { meetingId: meeting.id, folderId: destination });
        state.currentFolderId = destination;
        notify("Note moved.");
        await refresh();
      } catch (error) { notify(String(error), "error"); }
      finally { if (moveButton.isConnected) moveButton.disabled = false; }
    });
  }

  async function reprocessExtensionAudio() {
    const id = state.selectedId;
    const button = $("#reprocess-extension-audio");
    if (!id || !button) return;
    state.reprocessingIds.add(id);
    button.disabled = true;
    button.textContent = "Preparing audio copy…";
    try {
      const copyId = await invoke("desktop_reprocess_extension_audio", { meetingId: id });
      state.selectedId = copyId;
      state.detail = null;
      state.recoveringIds.add(copyId);
      state.reprocessingIds.delete(id);
      notify("A separate desktop copy is processing. The imported extension note is unchanged.");
      await refresh();
    } catch (error) {
      state.reprocessingIds.delete(id);
      notify(String(error), "error");
      await refresh();
    }
  }

  async function recoverMeeting() {
    const id = state.selectedId;
    const button = $("#recover-meeting");
    if (!id || !button) return;
    state.recoveringIds.add(id);
    button.disabled = true;
    button.textContent = "Finishing notes…";
    try {
      await invoke("desktop_recover_meeting", { meetingId: id });
      notify("Recovery started. Saved audio stays on this device while notes are prepared.");
      await refresh();
    } catch (error) {
      state.recoveringIds.delete(id);
      notify(String(error), "error");
      await refresh();
    }
  }

  async function deleteMeeting() {
    const id = state.selectedId;
    if (!id || !window.confirm(state.detail?.meeting?.textOnlyImport ? "Delete this imported note from this device? The original extension data is unchanged." : "Delete this recording, transcript, and notes from this device? This cannot be undone.")) return;
    const button = $("#delete-note");
    if (button) { button.disabled = true; button.textContent = "Deleting…"; }
    try {
      await invoke("desktop_delete_meeting", { meetingId: id });
      state.selectedId = null;
      state.detail = null;
      notify("Deleted from this device.");
      await refresh();
    } catch (error) {
      notify(String(error), "error");
      if (button?.isConnected) { button.disabled = false; button.textContent = state.detail?.meeting?.textOnlyImport ? "Delete imported note" : "Delete recording"; }
    }
  }

  const keyFields = [
    { id: "deepgram", label: "Deepgram", description: "Transcription", saved: "hasDeepgramKey" },
    { id: "groq", label: "Groq", description: "Transcription", saved: "hasGroqKey" },
    { id: "claude", label: "Anthropic Claude", description: "Summaries", saved: "hasClaudeKey" },
    { id: "gemini", label: "Google Gemini", description: "Summaries", saved: "hasGeminiKey" },
    { id: "deepseek", label: "DeepSeek", description: "Summaries", saved: "hasDeepseekKey" },
  ];

  function hostedForm(email) {
    return `<div class="form-grid hosted-form"><div class="form-field"><label class="field-label" for="hosted-email">Email</label><input class="text-input" id="hosted-email" type="email" autocomplete="username" value="${esc(email)}" /></div><div class="form-field"><label class="field-label" for="hosted-password">Password</label><input class="text-input" id="hosted-password" type="password" autocomplete="current-password" /></div></div>
      <div class="inline-actions"><button type="button" class="primary-button" id="hosted-sign-in">Sign in</button><button type="button" class="secondary-button" id="hosted-create-account">Create an account</button></div>
      <details class="other-keys browser-signin"><summary>Signed up with Google, or prefer your browser?</summary>
        <p class="fine-print">Sign in on the web app any way you like, create a code on its “Connect the desktop app” page, and paste it here. It signs this app in to the same account and workspace.</p>
        <div class="inline-actions"><button type="button" class="secondary-button" id="hosted-open-connect">Open the web app</button></div>
        <div class="key-row"><input class="text-input" id="hosted-code" type="text" autocomplete="off" spellcheck="false" placeholder="Paste sign-in code" aria-label="Sign-in code" /><button type="button" class="primary-button" id="hosted-code-submit">Connect</button></div></details>
      <p class="key-status" id="hosted-status" role="status" aria-live="polite"></p>`;
  }

  async function hostedAction(button, command, args, success) {
    if (!button || button.disabled) return;
    const label = button.textContent;
    const status = $("#hosted-status");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = command === "desktop_hosted_sign_out" ? "Signing out…" : "Signing in…";
    if (status) { status.textContent = ""; status.className = "key-status"; }
    try {
      const reply = await invoke(command, args);
      for (const field of [$("#hosted-password"), $("#hosted-code")]) if (field) field.value = "";
      state.syncWarning = reply?.syncWarning || "";
      if (state.syncWarning) notify(state.syncWarning, "warn");
      else notify(success);
      await refresh();
    } catch (error) {
      if (status?.isConnected) { status.textContent = String(error); status.className = "key-status error"; }
      notify(String(error), "error");
    } finally {
      if (button.isConnected) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = label; }
    }
  }


  // ---- Account: plan, action items, team (same data as the web app) ----
  const accountState = { overview: null, loading: false, error: "", team: { roster: null, loading: false, error: "", busy: false, message: "", link: "" }, actionQuery: "", actionFilter: "open", billingBusy: false };
  const hostedSignedIn = () => Boolean(state.snapshot?.settings.hasHostedSession);
  const longDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "";

  async function loadOverview(force = false) {
    if (!hostedSignedIn() || accountState.loading || (accountState.overview && !force)) return;
    accountState.loading = true;
    accountState.error = "";
    try { accountState.overview = await invoke("desktop_account_overview"); }
    catch (error) { accountState.error = String(error); void refresh(); }
    finally { accountState.loading = false; renderNav(state.setupNeeded); if (isAccountPage()) renderAccount(); }
  }

  async function loadRoster(force = false) {
    const team = accountState.team;
    if (!hostedSignedIn() || team.loading || (team.roster && !force)) return;
    team.loading = true;
    team.error = "";
    try { team.roster = await invoke("desktop_team_roster"); }
    catch (error) { team.error = String(error); void refresh(); }
    finally { team.loading = false; if (isAccountPage()) renderAccount(); }
  }

  function signInPrompt(what) {
    return `<div class="setup-callout">${icon("info")}<div><strong>Sign in to use ${esc(what)}</strong><span>Your AI Notetaker account shows the same plan and team as the web app. Recording and your local notes work without an account.</span><button class="small-button" id="account-sign-in">Sign in</button></div></div>`;
  }

  function usagePanel() {
    if (!hostedSignedIn()) return signInPrompt("your plan and usage");
    if (accountState.error) return `<div class="empty-state" role="alert"><strong>Could not load your plan</strong><p>${esc(accountState.error)}</p><button type="button" class="small-button" id="account-reload">Try again</button></div>`;
    const data = accountState.overview;
    if (!data) { void loadOverview(); return '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading your plan…</span></div>'; }
    const e = data.entitlements;
    const owner = data.account.role === "owner";
    const reset = e.period?.end ? longDate(e.period.end) : "";
    const notices = [];
    if (state.syncWarning) notices.push(state.syncWarning);
    if (e.inPaymentGrace) notices.push(`Your last payment failed. Sync continues until ${longDate(e.graceEndsAt)} while we retry. Update your payment method to keep it.`);
    if (!e.canSync) notices.push("Cloud sync is off. Your notes stay on this device and upload when a plan is active. Notes already in your account stay readable and exportable on the web.");
    if (data.subscription.cancelsAt) notices.push(`Your plan is set to end on ${longDate(data.subscription.cancelsAt)}.`);
    const current = e.plan;
    const offers = (data.offers || []).filter((offer) => offer.id !== current && offer.priceId);
    const billing = !owner
      ? '<p class="fine-print">Only the workspace owner can change the plan or billing.</p>'
      : `<div class="inline-actions">${offers.map((offer) => `<button class="${data.subscription.live ? "secondary-button" : "primary-button"}" data-upgrade="${esc(offer.priceId)}" ${accountState.billingBusy ? "disabled" : ""}>${data.subscription.live ? "Change to" : "Upgrade to"} ${esc(offer.name)}${offer.priceLabel ? ` · ${esc(offer.priceLabel)}` : ""}</button>`).join("")}${data.subscription.live || data.subscription.hasBillingAccount ? `<button class="secondary-button" id="manage-plan" ${accountState.billingBusy ? "disabled" : ""}>${data.subscription.live ? "Manage or cancel plan" : "Manage billing"}</button>` : ""}</div><p class="fine-print">Plan changes, payment details and cancellation open in your browser, on our payment provider’s secure page.</p>`;
    return `<section class="card account-card"><div class="account-head"><div><h2>${esc(e.planLabel)} plan</h2><p class="fine-print">${esc(data.workspace.name)} · ${esc(data.account.email)} · ${esc(data.statusLabel || e.status)}</p></div><button class="small-button" id="account-reload">Refresh</button></div>
      ${notices.map((text) => `<p class="setup-note">${esc(text)}</p>`).join("")}
      ${e.canSync ? '<p class="fine-print">Cloud sync is on for this workspace.</p>' : ""}${billing}</section>`;
  }

  function actionItemsPanel() {
    const query = accountState.actionQuery.trim().toLowerCase();
    const filter = accountState.actionFilter;
    const rows = [];
    for (const meeting of state.snapshot.meetings) {
      for (const [index, item] of (meeting.actionItems || []).entries()) rows.push({ meeting, item, index });
    }
    const isDone = (item) => item.status === "done";
    const counts = { open: rows.filter((row) => !isDone(row.item)).length, done: rows.filter((row) => isDone(row.item)).length, all: rows.length };
    const shown = rows.filter((row) => (filter === "all" || (filter === "done") === isDone(row.item)) && (!query || `${row.item.text} ${row.item.owner || ""} ${row.meeting.title}`.toLowerCase().includes(query)));
    const list = shown.length
      ? `<ul class="action-board">${shown.map(({ meeting, item, index }) => `<li><label><input type="checkbox" data-action-meeting="${esc(meeting.id)}" data-action-index="${index}" ${isDone(item) ? "checked" : ""} /><span class="${isDone(item) ? "done" : ""}">${esc(item.text)}${item.owner ? ` <em>· ${esc(item.owner)}</em>` : ""}</span></label><button class="inline-link" data-open-note="${esc(meeting.id)}">${esc(meeting.title)}</button></li>`).join("")}</ul>`
      : `<div class="empty-state"><strong>${rows.length ? "No matching action items" : "No action items yet"}</strong><p>${rows.length ? "Try another filter or search." : "Action items from your notes appear here, including notes made on the web."}</p></div>`;
    const chips = [["open", "Open"], ["done", "Done"], ["all", "All"]].map(([id, label]) => `<button class="filter-chip ${filter === id ? "active" : ""}" data-action-filter="${id}" aria-pressed="${filter === id}">${label} <span>${counts[id]}</span></button>`).join("");
    return `<section class="card account-card"><div class="filter-row">${chips}</div><input class="text-input" id="action-search" type="search" placeholder="Search action items" aria-label="Search action items" value="${esc(accountState.actionQuery)}" />${list}<p class="fine-print">Checking an item here updates it everywhere you are signed in. Offline, it stays on this device.</p></section>`;
  }

  function teamPanel() {
    if (!hostedSignedIn()) return signInPrompt("team management");
    const team = accountState.team;
    if (team.error) return `<div class="empty-state" role="alert"><strong>Could not load your team</strong><p>${esc(team.error)}</p><button type="button" class="small-button" id="team-reload">Try again</button></div>`;
    if (!team.roster) { void loadRoster(); return '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading your team…</span></div>'; }
    const you = accountState.overview?.account.email;
    const members = team.roster.members.map((member) => `<li class="team-row"><div><strong>${esc(member.email)}</strong><span class="fine-print"> ${member.email === you ? "(you) " : ""}· joined ${esc(longDate(member.joinedAt))}</span></div><div class="inline-actions"><select class="select-input" data-role-for="${esc(member.id)}" aria-label="Role for ${esc(member.email)}"><option value="member" ${member.role === "member" ? "selected" : ""}>Member</option><option value="owner" ${member.role === "owner" ? "selected" : ""}>Owner</option></select><button class="small-button" data-team-reset="${esc(member.id)}">Send password reset</button><button class="small-button danger" data-team-remove="${esc(member.id)}" data-email="${esc(member.email)}">Remove</button></div></li>`).join("");
    const invites = team.roster.invites.length ? `<h3 class="subhead">Pending invitations</h3><ul class="team-list">${team.roster.invites.map((invite) => `<li class="team-row"><span>${esc(invite.email)}</span><button class="small-button" data-team-revoke="${esc(invite.id)}">Revoke</button></li>`).join("")}</ul>` : "";
    return `<section class="card account-card"><p class="fine-print">${team.roster.members.length} member${team.roster.members.length === 1 ? "" : "s"}. Members share this workspace’s notes, plan and usage.</p>
      <div class="key-row"><input class="text-input" id="team-invite-email" type="email" placeholder="teammate@company.com" autocomplete="off" aria-label="Email address to invite" /><button type="button" class="primary-button" id="team-invite" ${team.busy ? "disabled aria-busy=\"true\"" : ""}>${team.busy ? "Sending…" : "Send invite"}</button></div>
      ${team.message ? `<p class="key-status" role="status">${esc(team.message)}${team.link ? ` <br><code>${esc(team.link)}</code>` : ""}</p>` : ""}
      <h3 class="subhead">Members</h3><ul class="team-list">${members}</ul>${invites}</section>`;
  }

  const ACCOUNT_SCREENS = {
    actions: ["Action items", "Everything you agreed to do, across all of your notes.", () => actionItemsPanel()],
    team: ["Team", "Invite teammates and manage who can use this workspace.", () => teamPanel()],
    plans: ["Plan", "Your plan and billing. A subscription adds cloud sync and team sync.", () => usagePanel()],
  };

  function renderAccount() {
    const [title, lede, panel] = ACCOUNT_SCREENS[state.page];
    setHeader(title, lede);
    $("#content").innerHTML = `<div class="account-layout">${panel()}</div>`;
    wireAccount();
  }

  async function accountAction(run, failure) {
    try { await run(); } catch (error) { notify(String(error || failure), "error"); }
  }

  function wireAccount() {
    $("#account-sign-in")?.addEventListener("click", () => { state.settingsOpen.processing = true; setPage("settings"); });
    $("#account-reload")?.addEventListener("click", () => { accountState.overview = null; accountState.error = ""; renderAccount(); void loadOverview(true); });
    $("#team-reload")?.addEventListener("click", () => { accountState.team.error = ""; accountState.team.roster = null; renderAccount(); });
    for (const button of document.querySelectorAll("[data-upgrade]")) button.addEventListener("click", () => accountAction(async () => { accountState.billingBusy = true; renderAccount(); try { await invoke("desktop_account_billing", { priceId: button.dataset.upgrade, manage: false }); notify("Opening the secure checkout in your browser. Come back and press Refresh when you finish."); } finally { accountState.billingBusy = false; renderAccount(); } }));
    $("#manage-plan")?.addEventListener("click", () => accountAction(async () => { accountState.billingBusy = true; renderAccount(); try { await invoke("desktop_account_billing", { priceId: null, manage: true }); notify("Opening billing in your browser. Come back and press Refresh when you finish."); } finally { accountState.billingBusy = false; renderAccount(); } }));
    $("#action-search")?.addEventListener("input", (event) => { accountState.actionQuery = event.target.value; const pos = event.target.selectionStart; renderAccount(); const box = $("#action-search"); box.focus(); box.setSelectionRange(pos, pos); });
    for (const chip of document.querySelectorAll("[data-action-filter]")) chip.addEventListener("click", () => { accountState.actionFilter = chip.dataset.actionFilter; renderAccount(); });
    for (const box of document.querySelectorAll("[data-action-meeting]")) box.addEventListener("change", async () => {
      box.disabled = true;
      try { await invoke("desktop_set_action_item", { meetingId: box.dataset.actionMeeting, index: Number(box.dataset.actionIndex), done: box.checked }); }
      catch (error) { notify(String(error), "error"); }
      finally { await refresh(); }
    });
    for (const link of document.querySelectorAll("[data-open-note]")) link.addEventListener("click", () => { state.selectedId = link.dataset.openNote; setPage("notes"); });
    const team = accountState.team;
    const act = (args, done) => accountAction(async () => {
      team.busy = true; team.message = ""; team.link = "";
      try {
        const reply = await invoke("desktop_team_action", args);
        if (reply.ok) { team.message = reply.message || "Saved."; team.link = reply.link || ""; team.roster = null; await loadRoster(true); done?.(); }
        else notify(reply.error, "error");
      } finally { team.busy = false; renderAccount(); }
    });
    const invite = () => { const email = $("#team-invite-email").value.trim(); if (!email) { notify("Enter an email address to invite.", "warn"); $("#team-invite-email").focus(); return; } if (!team.busy) act({ operation: "invite", email }); };
    $("#team-invite")?.addEventListener("click", invite);
    $("#team-invite-email")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); invite(); } });
    for (const select of document.querySelectorAll("[data-role-for]")) select.addEventListener("change", () => act({ operation: "role", id: select.dataset.roleFor, role: select.value }));
    for (const button of document.querySelectorAll("[data-team-reset]")) button.addEventListener("click", () => act({ operation: "reset", id: button.dataset.teamReset }));
    for (const button of document.querySelectorAll("[data-team-revoke]")) button.addEventListener("click", () => act({ operation: "revoke-invite", id: button.dataset.teamRevoke }));
    for (const button of document.querySelectorAll("[data-team-remove]")) button.addEventListener("click", () => { if (window.confirm(`Remove ${button.dataset.email} from this workspace? They lose access to its notes.`)) act({ operation: "remove", id: button.dataset.teamRemove }); });
  }

  function renderSettings() {
    setHeader("Settings", "Choose how notes are made and manage this app.");
    const s = state.snapshot.settings;
    const p = s.preferences;
    const vocabulary = Array.isArray(p.customVocabulary) ? p.customVocabulary.join("\n") : "";
    const transcription = `<option value="deepgram" ${p.transcriptionProvider === "deepgram" ? "selected" : ""}>Deepgram</option><option value="groq" ${p.transcriptionProvider === "groq" ? "selected" : ""}>Groq</option>`;
    const summarization = `<option value="claude" ${p.summarizationProvider === "claude" ? "selected" : ""}>Claude</option><option value="gemini" ${p.summarizationProvider === "gemini" ? "selected" : ""}>Gemini</option><option value="deepseek" ${p.summarizationProvider === "deepseek" ? "selected" : ""}>DeepSeek</option>`;
    const modes = `<option value="general" ${p.defaultMeetingMode === "general" ? "selected" : ""}>General</option><option value="standup" ${p.defaultMeetingMode === "standup" ? "selected" : ""}>Stand-up</option><option value="sales" ${p.defaultMeetingMode === "sales" ? "selected" : ""}>Sales</option><option value="one_on_one" ${p.defaultMeetingMode === "one_on_one" ? "selected" : ""}>1:1</option><option value="interview" ${p.defaultMeetingMode === "interview" ? "selected" : ""}>Interview</option><option value="lecture" ${p.defaultMeetingMode === "lecture" ? "selected" : ""}>Lecture</option><option value="custom" ${p.defaultMeetingMode === "custom" ? "selected" : ""}>Custom</option>`;
    let providerKeyMarkup = "";
    keyFields.forEach((key) => {
      providerKeyMarkup += `<div class="form-field" data-key-field="${key.id}"><label class="field-label" for="key-${key.id}">${key.label} <span class="fine-print">· ${key.description}</span></label><div class="key-row"><input class="text-input" id="key-${key.id}" type="password" autocomplete="new-password" placeholder="${s[key.saved] ? "Saved · paste a new key to replace it" : "Paste API key"}" /><button type="button" class="secondary-button test-key" data-provider="${key.id}" aria-label="Check ${key.label} key">Check key</button></div><p class="key-status" id="key-status-${key.id}" role="status" aria-live="polite">${s[key.saved] ? "A key is saved securely on this device." : "No key saved."}</p>${s[key.saved] ? `<label class="fine-print"><input type="checkbox" id="clear-${key.id}" /> Remove saved key</label>` : ""}</div>`;
    });
    const conflicts = state.snapshot.webappSync.conflicts || [];
    const conflictSummary = "Choose an action for each note: replace edited web versions, recreate removed web notes, or keep copies separate. Restore trashed notes before replacing them.";
    const conflictMarkup = conflicts.length
      ? `<details class="sync-conflicts"><summary>Review ${conflicts.length} note version conflict${conflicts.length === 1 ? "" : "s"}</summary><p>${conflictSummary}</p><div class="inline-actions">${conflicts.map((conflict) => {
        const meeting = state.snapshot.meetings.find((item) => item.id === conflict.meetingId);
        const title = meeting?.title ? esc(meeting.title) : "Meeting note";
        const desktopLabel = conflict.reason === "removed" ? "Recreate web version" : "Replace web version";
        const separateLabel = conflict.reason === "removed" ? "Keep desktop copy here" : "Keep both copies";
        const replaceUnavailable = conflict.reason === "trashed" || (conflict.reason === "updated" && !conflict.remoteUpdatedAt);
        const resolutionHint = conflict.reason === "trashed"
          ? "Restore this note in the web app before replacing it. You can still keep the desktop copy here."
          : conflict.reason === "updated" && !conflict.remoteUpdatedAt
            ? "The web app did not return its current note version. Update the web app and sync again before replacing it."
            : "";
        const hintMarkup = resolutionHint ? `<p class="fine-print">${resolutionHint}</p>` : "";
        const reviewAction = conflict.reason === "removed"
          ? `<span class="fine-print">Web copy removed</span>`
          : `<button type="button" class="secondary-button" data-sync-open="${esc(conflict.key)}" aria-label="${conflict.reason === "trashed" ? "Open Trash" : "Review web version"}: ${title}" ${state.syncInProgress ? "disabled" : ""}>${conflict.reason === "trashed" ? "Open Trash" : "Review web version"}</button>`;
        const desktopClass = conflict.reason === "removed" ? "primary-button" : "danger-button";
        return `<div class="sync-conflict-item"><strong>${title}</strong><div class="inline-actions">${reviewAction}<button type="button" class="${desktopClass}" data-sync-resolution="use_desktop" data-sync-reason="${esc(conflict.reason)}" data-sync-replace-unavailable="${replaceUnavailable}" data-sync-conflict="${esc(conflict.key)}" aria-label="${desktopLabel}: ${title}" ${replaceUnavailable || state.syncInProgress ? "disabled" : ""}>${desktopLabel}</button><button type="button" class="secondary-button" data-sync-resolution="keep_separate" data-sync-reason="${esc(conflict.reason)}" data-sync-conflict="${esc(conflict.key)}" aria-label="${separateLabel}: ${title}" ${state.syncInProgress ? "disabled" : ""}>${separateLabel}</button></div>${hintMarkup}</div>`;
      }).join("")}</div></details>`
      : "";
    const providersReady = providerKeySaved(s, p.transcriptionProvider) && providerKeySaved(s, p.summarizationProvider);
    const account = p.hostedAccount;
    if (account && s.hasHostedSession && !accountState.overview && !accountState.loading && !accountState.error) void loadOverview();
    const needsPlan = Boolean(account) && syncNeedsPlan(s, state.snapshot.webappSync);
    const processingBadge = !account
      ? ["Not signed in", ""]
      : !s.hasHostedSession ? ["Sign in again", "warn"] : needsPlan ? ["Needs plan", "warn"] : ["Signed in", "ok"];
    const syncOn = state.snapshot.webappSync.configured && !needsPlan;
    const cloudLine = `<p class="privacy-note cloud-status"><strong>${syncOn ? "Cloud sync is on." : needsPlan ? "Cloud sync is off." : "Not signed in."}</strong> ${syncOn ? "Finished notes sync with your workspace, the web app and your other devices. Deleting a note here removes it from this device only. Sync does not upload audio." : needsPlan ? "Your notes stay on this device, and anything you make now uploads when a plan is active. Notes already in your account stay readable on the web, and still download here. Choose a Pro or Team plan to sync notes again." : "Recording and notes work without an account. Sign in to manage your devices; a subscription adds cloud sync."}</p>${needsPlan ? '<div class="inline-actions"><button type="button" class="primary-button" id="upgrade-plan">See plans</button></div>' : ""}`;
    const syncState = state.snapshot.webappSync;
    const defaultOpen = { processing: Boolean(conflicts.length || syncState.lastError) || (!account && providersReady), providers: !providersReady, "note-style": false, import: false, about: false };
    const isOpen = (id) => (id in state.settingsOpen ? state.settingsOpen[id] : defaultOpen[id]);
    const sync_status = state.snapshot.webappSync.configured || conflicts.length ? `<p class="key-status" id="sync-status" role="status" aria-live="polite">${esc(state.syncInProgress ? "Syncing notes with your workspace…" : state.syncAnnouncement)}</p>` : "";
    const sync_controls = state.snapshot.webappSync.configured ? `<div class="sync-controls"><span class="fine-print">${state.snapshot.webappSync.lastSuccessAt ? `Last desktop upload ${esc(prettyDate(state.snapshot.webappSync.lastSuccessAt))}` : "Web app notes update when sync runs"}${state.snapshot.webappSync.lastError ? ` · ${esc(state.snapshot.webappSync.lastError)}` : ""}</span><div class="inline-actions"><button type="button" class="secondary-button" id="sync-existing" ${state.syncInProgress ? "disabled" : ""}>Sync existing desktop notes</button><button type="button" class="small-button" id="retry-sync" ${state.syncInProgress ? "disabled" : ""}>${state.syncInProgress ? "Syncing…" : "Sync now"}${!state.syncInProgress && state.snapshot.webappSync.pending ? ` · ${state.snapshot.webappSync.pending} waiting` : ""}</button></div>${state.snapshot.webappSync.separateCopies ? `<p class="fine-print">${state.snapshot.webappSync.separateCopies} note ${state.snapshot.webappSync.separateCopies === 1 ? "copy is" : "copies are"} kept separate from your workspace.</p>` : ""}<p class="fine-print">Sync now uploads pending desktop notes and updates notes copied from the web app.</p></div>` : "";
    const syncDetails = `<details class="other-keys"><summary>What gets synced</summary><div class="privacy-note"><p>Finished desktop notes upload to your workspace. Notes created in the web app are copied here and updated on the next sync. Web edits do not change recordings made on this desktop. Note deletions and settings do not sync between the desktop and web app.</p><p>Sync sends notes only; it does not send raw audio or provider keys.</p></div></details>`;
    const syncBlock = state.snapshot.webappSync.configured || conflicts.length ? `${conflictMarkup}${sync_status}${sync_controls}${syncDetails}` : "";
    const processingBody = cloudLine + syncBlock + (account
      ? `<div class="hosted-account"><p><strong>${esc(account.email)}</strong> · ${esc(planName(accountState.overview?.entitlements?.plan || account.plan))} plan</p>${s.hasHostedSession ? "" : '<p class="key-status">This session has ended. Sign in again to keep your notes syncing.</p>'}${state.syncWarning ? `<p class="setup-note" role="alert">${esc(state.syncWarning)}</p>` : ""}
        <div class="inline-actions"><button type="button" class="secondary-button" id="hosted-sign-out">Sign out</button><button type="button" class="secondary-button" id="hosted-manage-web">Manage account, devices &amp; data on the web</button></div></div>
        ${s.hasHostedSession ? "" : hostedForm(account.email)}`
      : hostedForm(""));
    const section = (id, title, badge, intro, body) => `<details class="card settings-card" id="settings-${id}" ${isOpen(id) ? "open" : ""}><summary><h2 tabindex="-1">${title}</h2><span class="section-badge ${badge[1]}">${esc(badge[0])}</span></summary><div class="settings-body"><p>${intro}</p>${body}</div></details>`;
    $("#content").innerHTML = `<div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections"><button type="button" data-settings-section="providers" aria-current="true">API keys${processingReady(s) ? "" : '<span class="nav-dot" role="img" aria-label="Needs setup"></span>'}</button><button type="button" data-settings-section="processing">Account &amp; sync</button><button type="button" data-settings-section="note-style">Notes &amp; language</button><button type="button" data-settings-section="import">Import data</button><button type="button" data-settings-section="about">About &amp; legal</button><div class="settings-nav-tools"><button type="button" id="expand-all">Expand all</button><button type="button" id="collapse-all">Collapse all</button></div></nav><form id="settings-form" class="settings-stack">
      ${state.snapshot.credentialStoreError ? `<div class="setup-callout">${icon("info")}<div><strong>Secure storage is unavailable</strong><span>${esc(state.snapshot.credentialStoreError)}</span></div></div>` : ""}
      ${section("providers", "API keys", providersReady ? ["Ready", "ok"] : ["Keys needed", "warn"],
        "Recordings go straight to the providers you pick; nothing passes through us. You need one transcription key and one summary key. Keys stay in your system's credential store.",
        `<div class="form-grid"><div class="form-field"><label class="field-label" for="transcription-provider">Transcription provider</label><select class="select-input" id="transcription-provider">${transcription}</select></div><div class="form-field"><label class="field-label" for="summarization-provider">Summary provider</label><select class="select-input" id="summarization-provider">${summarization}</select></div></div>
        <h3 class="subhead">Keys you need</h3><div class="form-grid" id="keys-active"></div>
        <details class="other-keys" id="other-keys-details"><summary>Other providers <span class="fine-print">optional · switch providers above to use them</span></summary><div class="form-grid" id="keys-other"></div></details>
        <template id="key-fields">${providerKeyMarkup}</template>
        <p class="fine-print">Raw audio is saved on this device first, then sent to your transcription provider.</p>`)}
      ${section("processing", "Account &amp; sync", processingBadge,
        "A free account lets you sign in and manage your devices. A subscription adds cloud sync across your devices and your team.",
        processingBody)}
      ${section("note-style", "Notes &amp; language", [meetingModeName(p.defaultMeetingMode), ""], "Choose the default summary style and words your providers should recognize.",
        `<div class="form-grid">
        <div class="form-field wide"><label class="field-label" for="meeting-mode">Default meeting style</label><select class="select-input" id="meeting-mode">${modes}</select></div>
        <div class="form-field wide"><label class="field-label" for="vocabulary">Custom vocabulary <span class="fine-print">one term per line</span></label><textarea class="text-area" id="vocabulary" placeholder="Product names, acronyms, and people">${esc(vocabulary)}</textarea></div>
        <div class="form-field wide"><label class="field-label" for="instructions">Summary instructions <span class="fine-print">optional</span></label><textarea class="text-area" id="instructions" maxlength="4000" placeholder="What should summaries focus on?">${esc(p.customSummaryInstructions)}</textarea></div></div>`)}
      ${section("import", "Import from the extension", ["Optional", ""], "Bring over browser meeting recordings and older notes. Import copies data; it never removes the extension source.",
        `<details class="other-keys"><summary>What is included</summary><p class="fine-print">A full archive brings new browser meeting recordings, older notes, partial transcripts, and any raw audio still saved by the extension. Older completed-call audio may already have been removed after notes were saved. API keys, web-app credentials, and Google connections stay separate.</p></details>
        <div class="inline-actions"><button type="button" class="secondary-button" id="import-desktop-audio-transfer">Choose full archive</button><button type="button" class="secondary-button" id="choose-desktop-transfer">Import notes-only file</button></div>
        <p class="key-status" id="desktop-audio-transfer-status" role="status" aria-live="polite"></p>
        <input id="desktop-transfer-file" type="file" accept=".json,application/json" hidden />
        <p class="key-status" id="desktop-transfer-status" role="status" aria-live="polite"></p>`)}
      ${section("about", "About &amp; legal", [`v${esc(state.snapshot.version)}`, ""], "AI Notetaker is open-source software under the MIT License. You decide when to record and must tell the people on the call, as the law and your workplace require.",
        `<div class="inline-actions">${[["privacy", "Privacy notice"], ["terms", "Terms"], ["license", "License"], ["third-party", "Third-party licenses"], ["source", "Source code"], ["issues", "Report a problem"]].map(([id, label]) => `<button type="button" class="secondary-button" data-about="${id}">${label}</button>`).join("")}</div>
        <p class="fine-print">${state.snapshot.audio?.platform === "linux"
          ? "AI Notetaker checks GitHub for signed releases and offers the download when one is ready (the AppImage installs it for you). Turn this off with Automatic Updates in the tray menu."
          : "AI Notetaker keeps itself up to date: it checks GitHub for signed releases and installs them, restarting only when nothing is recording. Turn this off with Automatic Updates in the tray menu."}</p>`)}
      <div class="settings-footer"><span class="settings-hint dirty" id="settings-hint" ${state.settingsDirty ? "" : "hidden"}>Unsaved changes</span><button type="submit" class="primary-button" id="save-settings">Save settings</button></div>
    </form></div>`;
    const arrangeProviderKeys = () => {
      const chosen = new Set([$("#transcription-provider").value, $("#summarization-provider").value]);
      const active = $("#keys-active");
      const other = $("#keys-other");
      for (const field of document.querySelectorAll("[data-key-field]")) (chosen.has(field.dataset.keyField) ? active : other).append(field);
    };
    const keyTemplate = $("#key-fields");
    $("#keys-other").append(keyTemplate.content);
    arrangeProviderKeys();
    $("#transcription-provider").addEventListener("change", arrangeProviderKeys);
    $("#summarization-provider").addEventListener("change", arrangeProviderKeys);
    for (const details of document.querySelectorAll(".settings-card")) details.addEventListener("toggle", () => {
      state.settingsOpen[details.id.replace("settings-", "")] = details.open;
    });
    const setAll = (open) => { for (const details of document.querySelectorAll(".settings-card")) details.open = open; };
    $("#expand-all").addEventListener("click", () => setAll(true));
    $("#collapse-all").addEventListener("click", () => setAll(false));
    $("#settings-form").addEventListener("submit", saveSettings);
    const signIn = $("#hosted-sign-in");
    if (signIn) {
      const email = $("#hosted-email");
      const password = $("#hosted-password");
      const submit = () => hostedAction(signIn, "desktop_hosted_sign_in", { email: email.value, password: password.value, baseUrl: p.hostedAccount?.baseUrl || null }, "Signed in.");
      signIn.addEventListener("click", submit);
      for (const field of [email, password]) {
        // Sign-in is its own action: Enter must not submit the settings form, and typing here is not a settings change.
        field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
        field.addEventListener("input", (event) => event.stopPropagation());
        field.addEventListener("change", (event) => event.stopPropagation());
      }
    }
    for (const link of document.querySelectorAll("[data-about]")) link.addEventListener("click", async () => { try { await invoke("desktop_open_about_link", { page: link.dataset.about }); } catch (error) { notify(String(error), "error"); } });
    $("#upgrade-plan")?.addEventListener("click", () => setPage("plans"));
    $("#hosted-manage-web")?.addEventListener("click", async () => { try { await invoke("desktop_open_web_page", { page: "account" }); } catch (error) { notify(String(error), "error"); } });
    $("#hosted-open-connect")?.addEventListener("click", async () => { try { await invoke("desktop_open_connect_page"); } catch (error) { notify(String(error), "error"); } });
    const codeField = $("#hosted-code");
    if (codeField) {
      const submitCode = () => hostedAction($("#hosted-code-submit"), "desktop_hosted_sign_in_code", { code: codeField.value, baseUrl: p.hostedAccount?.baseUrl || null }, "Signed in. Your notes now sync with your account.");
      $("#hosted-code-submit").addEventListener("click", submitCode);
      codeField.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submitCode(); } });
      codeField.addEventListener("input", (event) => event.stopPropagation());
    }
    $("#hosted-create-account")?.addEventListener("click", async () => { try { await invoke("desktop_open_webapp"); } catch (error) { notify(String(error), "error"); } });
    $("#hosted-sign-out")?.addEventListener("click", (event) => hostedAction(event.currentTarget, "desktop_hosted_sign_out", {}, "Signed out. Your notes stay on this device."));
    const markDirty = () => { state.settingsDirty = true; const hint = $("#settings-hint"); if (hint) hint.hidden = false; };
    $("#settings-form").addEventListener("input", markDirty);
    $("#settings-form").addEventListener("change", markDirty);
    for (const button of document.querySelectorAll(".test-key")) button.addEventListener("click", () => testKey(button.dataset.provider));
    $("#sync-existing")?.addEventListener("click", syncExisting);
    $("#retry-sync")?.addEventListener("click", retrySync);
    for (const button of document.querySelectorAll("[data-sync-open]")) button.addEventListener("click", async () => {
      try { await invoke("desktop_open_webapp_conflict", { conflictKey: button.dataset.syncOpen }); }
      catch (error) { notify(String(error), "error"); }
    });
    for (const button of document.querySelectorAll("[data-sync-resolution]")) button.addEventListener("click", async () => {
      const resolution = button.dataset.syncResolution;
      if (resolution === "use_desktop" && button.dataset.syncReason !== "removed" && !window.confirm("Replace the current web note and its online edits with the saved desktop note? Your desktop copy stays saved locally.")) return;
      state.syncInProgress = true;
      state.syncAnnouncement = "";
      updateSyncFeedback();
      try {
        trackSyncRun(await invoke("desktop_resolve_webapp_conflict", {
          conflictKey: button.dataset.syncConflict,
          resolution,
        }));
      } catch (error) {
        state.syncInProgress = false;
        state.syncAnnouncement = `Conflict could not be resolved: ${String(error)}`;
        updateSyncFeedback();
        notify(String(error), "error");
      }
    });
    $("#choose-desktop-transfer")?.addEventListener("click", () => $("#desktop-transfer-file").click());
    $("#desktop-transfer-file")?.addEventListener("change", importDesktopTransfer);
    $("#import-desktop-audio-transfer")?.addEventListener("click", importDesktopAudioTransfer);
    for (const button of document.querySelectorAll("[data-settings-section]")) button.addEventListener("click", () => {
      for (const item of document.querySelectorAll("[data-settings-section]")) item.removeAttribute("aria-current");
      button.setAttribute("aria-current", "true");
      const section = document.getElementById(`settings-${button.dataset.settingsSection}`);
      if (section) section.open = true;
      section?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      section?.querySelector("h2")?.focus({ preventScroll: true });
    });
  }

  async function importDesktopAudioTransfer() {
    const status = $("#desktop-audio-transfer-status");
    const button = $("#import-desktop-audio-transfer");
    button.disabled = true;
    status.textContent = "Choose an archive to import…";
    status.className = "key-status";
    try {
      const report = await invoke("desktop_import_audio_transfer");
      if (!report) {
        status.textContent = "Import cancelled. No desktop data changed.";
        return;
      }
      state.settingsDirty = false;
      const audioStatus = report.audioImported
        ? ` Saved ${(report.audioBytes / (1024 * 1024)).toFixed(1)} MB of audio for ${report.audioImported} recording${report.audioImported === 1 ? "" : "s"}.`
        : " No raw audio remained in the extension archive; imported notes are stored on this device.";
      status.textContent = `Imported ${report.imported} meeting${report.imported === 1 ? "" : "s"}; skipped ${report.alreadyPresent} already here.${audioStatus} The extension source is unchanged.`;
      status.className = "key-status ok";
      notify(`Imported ${report.imported} meeting${report.imported === 1 ? "" : "s"}; skipped ${report.alreadyPresent} already in this library.`);
      await refresh();
    } catch (error) {
      status.textContent = String(error);
      status.className = "key-status error";
    } finally {
      button.disabled = false;
    }
  }

  async function importDesktopTransfer(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const status = $("#desktop-transfer-status");
    const button = $("#choose-desktop-transfer");
    if (file.size > 20 * 1024 * 1024) {
      status.textContent = "Transfer files must be smaller than 20 MB.";
      status.className = "key-status error";
      input.value = "";
      return;
    }
    button.disabled = true;
    status.textContent = "Checking transfer file…";
    status.className = "key-status";
    try {
      const report = await invoke("desktop_import_transfer", { contents: await file.text() });
      state.settingsDirty = false;
      notify(`Imported ${report.imported} note${report.imported === 1 ? "" : "s"}; skipped ${report.alreadyPresent} already in this library. Saved API keys and web-app token were not changed.`);
      status.className = "key-status ok";
      await refresh();
    } catch (error) {
      status.textContent = String(error);
      status.className = "key-status error";
    } finally {
      input.value = "";
      button.disabled = false;
    }
  }

  async function testKey(provider) {
    const input = $(`#key-${provider}`);
    const status = $(`#key-status-${provider}`);
    const key = input.value.trim();
    if (!key) { status.textContent = "Paste a key above, then check it."; status.className = "key-status warn"; input.focus(); return; }
    const button = document.querySelector(`.test-key[data-provider="${provider}"]`);
    if (button?.disabled) return;
    const buttonLabel = button?.getAttribute("aria-label");
    if (button) { button.disabled = true; button.textContent = "Checking…"; button.setAttribute("aria-label", `Checking ${providerName(provider)} key`); }
    status.textContent = `Checking with ${providerName(provider)}…`;
    status.className = "key-status";
    try {
      const result = await invoke("desktop_test_provider_key", { provider, key });
      status.textContent = result.valid ? `${result.message} Select Save settings to keep it.` : result.message;
      status.className = `key-status ${result.valid ? "ok" : "error"}`;
    } catch (error) { status.textContent = String(error); status.className = "key-status error"; }
    finally { if (button?.isConnected) { button.disabled = false; button.textContent = "Check key"; if (buttonLabel) button.setAttribute("aria-label", buttonLabel); } }
  }

  async function syncExisting() {
    state.syncInProgress = true;
    state.syncAnnouncement = "";
    updateSyncFeedback();
    try { const reply = await invoke("desktop_sync_existing_notes"); const count = reply.queued; trackSyncRun(reply.runId); notify(count ? `Queued ${count} finished note${count === 1 ? "" : "s"} for sync.` : "There are no finished desktop notes to sync yet."); await refresh(); }
    catch (error) { state.syncInProgress = false; state.syncAnnouncement = `Sync could not start: ${String(error)}`; updateSyncFeedback(); notify(String(error), "error"); }
  }

  async function retrySync() {
    state.syncInProgress = true;
    state.syncAnnouncement = "";
    updateSyncFeedback();
    try { trackSyncRun(await invoke("desktop_retry_webapp_sync")); await refresh(); }
    catch (error) { state.syncInProgress = false; state.syncAnnouncement = `Sync could not start: ${String(error)}`; updateSyncFeedback(); notify(String(error), "error"); }
  }

  // Background sync runs every minute, so "Syncing…" ends only when the run this person started
  // reports back. Its event can arrive before the command returns, so finished runs are remembered.
  function trackSyncRun(runId) {
    const finished = state.finishedSyncRuns.find((run) => run.id === runId);
    if (finished) finishSyncRun(true, finished.error);
    else state.syncRunId = runId;
  }
  function finishSyncRun(requested, error = "") {
    if (requested) { state.syncInProgress = false; state.syncRunId = null; }
    const announcement = error ? `Sync finished with an issue: ${error}` : requested ? "Sync complete." : "";
    if (requested || announcement !== state.syncAnnouncement) {
      state.syncAnnouncement = announcement;
      updateSyncFeedback();
    }
  }

  function updateSyncFeedback() {
    const status = $("#sync-status");
    if (status) status.textContent = state.syncInProgress
      ? "Syncing notes with your workspace…"
      : state.syncAnnouncement;
    const retry = $("#retry-sync");
    if (retry) {
      retry.disabled = state.syncInProgress;
      retry.textContent = state.syncInProgress ? "Syncing…" : "Sync now";
    }
    const existing = $("#sync-existing");
    if (existing) existing.disabled = state.syncInProgress;
    for (const action of document.querySelectorAll("[data-sync-resolution], [data-sync-open]")) {
      action.disabled = state.syncInProgress
        || action.dataset.syncResolution === "use_desktop" && action.dataset.syncReplaceUnavailable === "true";
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const button = $("#save-settings");
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Saving…";
    const payload = {
      transcriptionProvider: $("#transcription-provider").value,
      summarizationProvider: $("#summarization-provider").value,
      defaultMeetingMode: $("#meeting-mode").value,
      customVocabulary: $("#vocabulary").value.split("\n"),
      customSummaryInstructions: $("#instructions").value,
    };
    for (const key of keyFields) payload[`${key.id}Key`] = $(`#clear-${key.id}`)?.checked ? "" : $(`#key-${key.id}`).value || null;
    try {
      await invoke("desktop_save_settings", { input: payload });
      state.settingsDirty = false;
      notify("Settings saved securely on this device.");
      await refresh();
    } catch (error) { notify(String(error), "error"); }
    finally { if (button.isConnected) { button.disabled = false; button.removeAttribute("aria-busy"); button.textContent = "Save settings"; } }
  }

  $("#open-notes-folder").addEventListener("click", async () => { try { await invoke("desktop_open_notes_folder"); } catch (error) { notify(String(error), "error"); } });
  $("#open-webapp").addEventListener("click", async () => { try { await invoke("desktop_open_web_page", { page: "library" }); } catch (error) { notify(String(error), "error"); } });

  if (!invoke) {
    $("#content").innerHTML = '<div class="empty-state" role="alert"><strong>AI Notetaker couldn\'t start</strong><p>Quit and reopen the app.</p></div>';
    return;
  }
  if (listen) listen("helper-message", (event) => {
    const message = event.payload;
    if (message?.type === "error") {
      if (message.meetingId) state.recoveringIds.delete(message.meetingId);
      notify(message.message || "Something went wrong. Your saved audio is safe.", "error");
      refresh();
    } else if (["recording_started", "recording_stopped", "summary_ready", "recovered_recording", "audio_status", "audio_probe_result"].includes(message?.type)) {
      if (message?.type === "summary_ready" && message.meetingId) state.recoveringIds.delete(message.meetingId);
      refresh();
    }
  }).catch(() => {});
  // Tray "Open Latest Note": the window is already shown; open the newest note in the app.
  if (listen) listen("open-latest-note", async () => {
    if (!state.snapshot) await refresh();
    const meetings = state.snapshot?.meetings || [];
    const latest = meetings.reduce((newest, meeting) => (!newest || Date.parse(meeting.startedAt) > Date.parse(newest.startedAt) ? meeting : newest), null);
    if (latest) void openMeeting(latest.id);
    else if (state.snapshot) setPage("notes");
  }).catch(() => {});
  if (listen) listen("webapp-sync-updated", (event) => {
    // Background sync reports here every minute too; only a sync the person started, or a changed
    // problem, is announced, so screen readers do not hear "Sync complete." over and over.
    const runId = event.payload?.runId;
    if (runId != null) state.finishedSyncRuns = [...state.finishedSyncRuns.slice(-19), { id: runId, error: event.payload?.lastError || "" }];
    const requested = state.syncInProgress && runId != null && runId === state.syncRunId;
    // While a started run is still going, a background run's result must not end "Syncing…".
    if (state.syncInProgress && !requested) { void refresh({ passive: true }); return; }
    finishSyncRun(requested, event.payload?.lastError || "");
    void refresh({ passive: !requested });
  }).catch(() => {});

  const REFRESH_INTERVAL_MS = 15000;
  let refreshInterval = null;
  function stopRefreshPolling() {
    if (refreshInterval === null) return;
    window.clearInterval(refreshInterval);
    refreshInterval = null;
  }
  function startRefreshPolling() {
    if (refreshInterval !== null || document.visibilityState !== "visible") return;
    refreshInterval = window.setInterval(() => {
      if (refreshTask === null && !state.busy && state.page !== "settings" && !isAccountPage()) void refresh({ passive: true });
    }, REFRESH_INTERVAL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refresh();
      startRefreshPolling();
    } else {
      stopRefreshPolling();
    }
  });
  refresh();
  startRefreshPolling();
})();
