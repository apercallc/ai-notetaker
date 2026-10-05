(() => {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;
  const state = { page: "record", snapshot: null, detail: null, detailError: null, selectedId: null, currentFolderId: null, busy: false, recordTitle: "", notesQuery: "", recordConsentAcknowledged: false, finalizingMeetingIds: new Set(), recoveringIds: new Set(), reprocessingIds: new Set(), settingsDirty: false, syncInProgress: false, syncAnnouncement: "", noticeTimer: 0 };
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
  const providerName = (id) => ({ deepgram: "Deepgram", groq: "Groq", claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek" })[id] || id;
  const providerKeySaved = (settings, id) => settings[{ deepgram: "hasDeepgramKey", groq: "hasGroqKey", claude: "hasClaudeKey", gemini: "hasGeminiKey", deepseek: "hasDeepseekKey" }[id]];
  const meetingModeName = (id) => ({ general: "General", standup: "Stand-up", sales: "Sales", one_on_one: "1:1", interview: "Interview", lecture: "Lecture", custom: "Custom" })[id] || id;
  const platformName = (id) => ({ macos: "macOS", windows: "Windows", linux: "Linux" })[id] || id;

  function notify(message, kind = "") {
    const box = $("#notice");
    box.textContent = message;
    box.className = `notice ${kind}`.trim();
    box.hidden = !message;
    clearTimeout(state.noticeTimer);
    if (message) state.noticeTimer = setTimeout(() => { box.hidden = true; }, 6500);
  }

  function setTopbarStatus(label, dotClass = "") {
    const status = $("#topbar-status");
    const nextDotClass = `status-dot ${dotClass}`.trim();
    if (status.dataset.label === label && status.dataset.dotClass === nextDotClass) return;
    status.dataset.label = label;
    status.dataset.dotClass = nextDotClass;
    status.innerHTML = `<span class="${nextDotClass}"></span><span>${esc(label)}</span>`;
  }

  let refreshTask = null;
  let refreshQueued = false;
  function refresh() {
    if (document.visibilityState === "hidden") return Promise.resolve();
    refreshQueued = true;
    if (refreshTask) return refreshTask;
    refreshTask = (async () => {
      try {
        while (refreshQueued && document.visibilityState !== "hidden") {
          refreshQueued = false;
          await refreshSnapshot();
        }
      } finally {
        refreshTask = null;
      }
    })();
    return refreshTask;
  }

  async function refreshSnapshot() {
    try {
      state.snapshot = await invoke("desktop_snapshot");
      for (const meetingId of state.finalizingMeetingIds) {
        const meeting = state.snapshot.meetings.find((item) => item.id === meetingId);
        if (!meeting || meeting.status !== "recording") state.finalizingMeetingIds.delete(meetingId);
      }
      if (state.page === "settings" && state.settingsDirty) return;
      if (state.page === "notes" && ($("#new-folder-form:not([hidden])") || $("#folder-manage:not([hidden])")
        || document.activeElement?.id === "note-folder")) return;
      if (state.selectedId && state.page === "notes") await loadDetail(state.selectedId, false);
      const focused = document.activeElement;
      const focusedId = ["meeting-title", "notes-search"].includes(focused?.id) ? focused.id : null;
      const selection = focusedId ? [focused.selectionStart, focused.selectionEnd] : null;
      render();
      if (focusedId) {
        const replacement = document.getElementById(focusedId);
        replacement?.focus({ preventScroll: true });
        if (selection && selection.every(Number.isInteger)) replacement?.setSelectionRange(...selection);
      }
    } catch (error) {
      $("#content").innerHTML = `<div class="empty-state"><strong>Workspace could not open</strong>${esc(error)}<p><button class="secondary-button" id="retry-load">Try again</button></p></div>`;
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
    for (const button of document.querySelectorAll(".nav-button")) {
      const active = button.dataset.page === page;
      button.classList.toggle("active", active);
      active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
    }
    render();
    if (page === "notes" && state.selectedId) void loadDetail(state.selectedId);
  }

  function setHeader(title, eyebrow) {
    $("#page-title").textContent = title;
    $("#page-eyebrow").textContent = eyebrow;
  }

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    $("#app-version").textContent = `Version ${snapshot.version}`;
    const recording = Boolean(snapshot.activeMeetingId);
    const preferences = snapshot.settings.preferences;
    const providersReady = providerKeySaved(snapshot.settings, preferences.transcriptionProvider)
      && providerKeySaved(snapshot.settings, preferences.summarizationProvider);
    const appReady = !snapshot.credentialStoreError && providersReady;
    const processing = snapshot.meetings.some((meeting) => meeting.status === "processing");
    const finalizing = snapshot.meetings.some((meeting) => state.finalizingMeetingIds.has(meeting.id) && meeting.status === "recording");
    const audioChecking = snapshot.audio.checking;
    const needsAttention = !recording && !processing && !finalizing && (!appReady || (!audioChecking && !snapshot.audio.ready));
    setTopbarStatus(
      recording ? "Recording on this device" : finalizing ? "Finishing saved audio" : processing ? "Preparing saved notes" : !appReady ? "Setup needed" : audioChecking ? snapshot.audio.timedOut ? "Audio check taking longer" : "Checking audio" : snapshot.audio.ready ? "Ready to record" : snapshot.audio.permissionRequired ? "Audio permission needed" : "Audio setup needed",
      recording ? "recording" : needsAttention ? "needs-attention" : "",
    );
    $("#open-webapp").hidden = !snapshot.settings.preferences.webappUrl;
    if (snapshot.credentialStoreError) notify(snapshot.credentialStoreError, "error");
    else if (snapshot.unreadableRecordings) notify(`${snapshot.unreadableRecordings} recording${snapshot.unreadableRecordings === 1 ? "" : "s"} could not be read. Other notes remain available.`, "warn");
    try {
      if (state.page === "record") renderRecord();
      else if (state.page === "notes") renderNotes();
      else renderSettings();
    } catch (error) {
      console.error("Page render failed", state.page, error);
      $("#content").innerHTML = '<div class="empty-state"><strong>This page could not be displayed</strong><p>Return to this page or restart the app. Your local notes remain saved.</p></div>';
    }
  }

  function renderRecord() {
    setHeader("Record a meeting", "YOUR DESKTOP NOTETAKER");
    const s = state.snapshot;
    const active = s.activeMeetingId;
    const audio = s.audio;
    const keyReady = providerKeySaved(s.settings, s.settings.preferences.transcriptionProvider)
      && providerKeySaved(s.settings, s.settings.preferences.summarizationProvider);
    const setup = s.credentialStoreError || !keyReady;
    const setupMessage = s.credentialStoreError || `Add your ${providerName(s.settings.preferences.transcriptionProvider)} and ${providerName(s.settings.preferences.summarizationProvider)} API keys in Settings to start.`;
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
    const openAudioSettings = audio.platform === "macos" && audio.driver === "Unavailable"
      ? '<button class="small-button" id="open-screen-recording-settings">Open macOS audio permissions</button>'
      : "";
    const recent = s.meetings.slice(0, 3);
    const recoverable = s.meetings.find((meeting) => meeting.status === "recovered" && !meeting.textOnlyImport);
    const processing = s.meetings.filter((meeting) => meeting.status === "processing").length;
    const finalizing = s.meetings.some((meeting) => state.finalizingMeetingIds.has(meeting.id) && meeting.status === "recording");
    $("#content").innerHTML = `
      ${setup ? `<div class="setup-callout"><span aria-hidden="true">ⓘ</span><div><strong>${s.credentialStoreError ? "Secure credential storage is unavailable" : "Finish setup to record"}</strong><span>${esc(setupMessage)}${s.credentialStoreError ? "" : " Your provider keys stay in this device’s credential store."}</span></div></div>` : ""}
      ${recoverable ? `<div class="setup-callout"><span aria-hidden="true">ⓘ</span><div><strong>Saved audio needs recovery</strong><span>${esc(recoverable.title)} was interrupted. Its audio is still on this device.</span><button class="small-button" id="open-recoverable">Open recording</button></div></div>` : ""}
      ${processing ? `<p class="process-status" role="status">Preparing notes from ${processing} saved recording${processing === 1 ? "" : "s"}. You can keep using the app.</p>` : ""}
      ${finalizing ? '<p class="process-status">Finishing saved audio. It stays on this device while notes are prepared.</p>' : ""}
      <div class="record-grid">
        <section class="card record-card" aria-labelledby="record-heading">
          <div class="record-intro"><h2 id="record-heading">${active ? "Recording is in progress" : "Start a recording"}</h2><p>${active ? "Audio is being saved on this device while your notes are prepared." : "Record a browser or desktop call and keep the audio and notes on this device."}</p></div>
          <label class="field-label" for="meeting-title">Meeting title <span class="fine-print">(optional)</span></label>
          <input id="meeting-title" class="text-input" maxlength="200" value="${esc(state.recordTitle)}" placeholder="e.g. Product planning" ${active ? "disabled" : ""} />
          <label class="consent-row"><input id="record-consent" type="checkbox" ${state.recordConsentAcknowledged ? "checked" : ""} ${active ? "disabled" : ""} /><span>I’ve told everyone on the call that recording is starting.</span></label>
          <div class="record-actions">${active
            ? `<button class="danger-button" id="stop-recording"><span class="record-icon"></span>Stop recording</button><span class="fine-print">Recording ID ${esc(active.slice(0, 8))}</span>`
            : `<button class="primary-button" id="start-recording" ${!state.recordConsentAcknowledged || !audio.ready || !keyReady || s.credentialStoreError || state.busy ? "disabled" : ""}><span class="record-icon"></span>Start recording</button><span class="fine-print" id="start-recording-hint">${esc(startHint)}</span>`}
          </div>
        </section>
        <section class="card audio-card" aria-labelledby="audio-heading">
          <div class="audio-card-head"><h2 id="audio-heading">Audio setup</h2><span class="readiness ${audio.checking ? "checking" : audio.ready ? "" : "warn"}">${audio.checking ? audio.timedOut ? "Check taking longer" : "Checking audio" : audio.ready ? "Ready" : audio.permissionRequired ? "Permission needed" : "Check setup"}</span></div>
          <div class="device-list">
            <div class="device-row"><span class="device-icon" aria-hidden="true">◖</span><div><strong>Microphone</strong><span>${esc(audio.microphone || "Default microphone")}</span></div></div>
            <div class="device-row"><span class="device-icon" aria-hidden="true">◉</span><div><strong>System audio</strong><span>${esc(audio.speaker || "Default output")}</span></div></div>
            <div class="device-row"><span class="device-icon" aria-hidden="true">⌘</span><div><strong>${esc(platformName(audio.platform))} audio</strong><span>${esc(audio.driver)}</span></div></div>
          </div>
          <p class="guidance">${esc(audio.guidance || "Audio will be captured from your current microphone and system output.")}</p>
          <div class="audio-actions">${openAudioSettings}<button class="small-button" id="check-audio">Check audio again</button></div>
        </section>
      </div>
      <div class="section-heading"><div><h2>Recent notes</h2><p>Your recordings are saved locally first.</p></div><button class="small-button" id="all-notes">View all</button></div>
      ${recent.length ? `<div class="recent-list">${recent.map((meeting) => meetingCard(meeting)).join("")}</div>` : `<div class="empty-state"><strong>No recordings yet</strong>Start a recording. Your transcript and notes will appear here.</div>`}`;
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
    });
    $("#meeting-title")?.addEventListener("input", (event) => { state.recordTitle = event.currentTarget.value; });
    $("#open-recoverable")?.addEventListener("click", () => openMeeting(recoverable.id));
    $("#start-recording")?.addEventListener("click", startRecording);
    $("#stop-recording")?.addEventListener("click", stopRecording);
    $("#check-audio")?.addEventListener("click", checkAudio);
    $("#open-screen-recording-settings")?.addEventListener("click", openScreenRecordingSettings);
    $("#all-notes")?.addEventListener("click", () => setPage("notes"));
    for (const button of document.querySelectorAll("[data-meeting-id]")) button.addEventListener("click", () => openMeeting(button.dataset.meetingId));
  }

  function meetingCard(meeting) {
    const preview = state.finalizingMeetingIds.has(meeting.id) ? "Finishing saved audio" : meeting.summary || (meeting.actionItems.length ? meeting.actionItems.map((item) => item.text).join(" · ") : statusLabel(meeting.status));
    return `<button class="meeting-card" data-meeting-id="${esc(meeting.id)}"><strong>${esc(meeting.title)}</strong><time>${esc(prettyDate(meeting.startedAt))}</time><span class="preview">${esc(preview)}</span></button>`;
  }

  function recordingStartHint({ credentialStoreError, keyReady, audio, consentAcknowledged, busy, audioChecking, audioTimedOut }) {
    if (busy) return "Starting recording…";
    const blockers = [];
    if (credentialStoreError) blockers.push("Resolve the secure storage issue above to enable recording.");
    else if (!keyReady) blockers.push("Finish provider setup above to enable recording.");
    if (!audio.ready) blockers.push(audioChecking
      ? audioTimedOut ? "The audio check is taking longer than expected. Follow the guidance below before recording." : "Wait for the audio device check to finish."
      : "Resolve the audio issue below to enable recording.");
    if (!consentAcknowledged) blockers.push("Confirm recording consent above to enable recording.");
    return blockers.length ? blockers.join(" ") : "Microphone and system audio are kept on separate tracks.";
  }

  function statusLabel(status) { return ({ recording: "Recording", processing: "Preparing your notes", recovered: "Recovered recording", complete: "Notes ready", saved: "Audio saved" })[status] || status; }

  async function startRecording() {
    if (!state.recordConsentAcknowledged || state.busy) return;
    const title = $("#meeting-title").value;
    const consent = state.recordConsentAcknowledged;
    state.busy = true;
    const button = $("#start-recording");
    if (button) { button.disabled = true; button.textContent = "Starting recording…"; }
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
    if (button) { button.disabled = true; button.textContent = "Stopping…"; }
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
    try { await invoke("desktop_test_audio"); notify("Audio check started. This can take a few seconds."); setTimeout(refresh, 900); }
    catch (error) { notify(String(error), "error"); }
  }

  async function openScreenRecordingSettings() {
    try {
      await invoke("desktop_open_screen_recording_settings");
      notify("System Settings opened. Add or enable AI Notetaker, reopen the app, then check audio again.");
    } catch (error) { notify(String(error), "error"); }
  }

  function renderNotes() {
    setHeader("Library", "LOCAL RECORDING LIBRARY");
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
      <section class="card note-detail" id="note-detail">${state.detailError ? `<div class="empty-state"><strong>Note could not open</strong>${esc(state.detailError)}</div>` : state.selectedId ? '<div class="loading-state"><span class="spinner"></span><span>Opening note…</span></div>' : '<div class="empty-state"><strong>Select a recording</strong>Your transcript, summary, and action items will appear here.</div>'}</section>
    </div>`;
    const search = $("#notes-search");
    search.addEventListener("input", () => { state.notesQuery = search.value; renderMeetingList(state.notesQuery, noteCounts); });
    renderMeetingList(state.notesQuery, noteCounts);
    $("#meeting-list").scrollTop = listScroll;
    for (const button of document.querySelectorAll("[data-folder-path]")) button.addEventListener("click", () => openFolder(button.dataset.folderPath || null));
    $("#new-folder")?.addEventListener("click", () => { $("#new-folder-form").hidden = false; $("#folder-name").focus(); });
    $("#cancel-folder")?.addEventListener("click", () => { $("#new-folder-form").hidden = true; });
    $("#new-folder-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try { await invoke("desktop_create_folder", { parentId: state.currentFolderId, name: $("#folder-name").value }); $("#new-folder-form").hidden = true; notify("Folder created."); await refresh(); }
      catch (error) { notify(String(error), "error"); }
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
    if (state.detail) renderDetail(state.detail);
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
    const folderRows = childFolders.map((folder) => { const count = noteCounts.get(folder.id) || 0; return `<button class="folder-list-item" data-open-folder="${esc(folder.id)}"><span aria-hidden="true">▤</span><strong>${esc(folder.name)}</strong><span>${count} ${count === 1 ? "note" : "notes"}</span></button>`; }).join("");
    list.innerHTML = folderRows + (filtered.length ? filtered.map((meeting) => `<button class="meeting-list-item ${meeting.id === state.selectedId ? "selected" : ""}" data-id="${esc(meeting.id)}"><strong>${esc(meeting.title)}</strong><span>${esc(prettyDate(meeting.startedAt))} · ${esc(statusLabel(meeting.status))}</span></button>`).join("") : !folderRows ? `<div class="empty-state">${state.snapshot.meetings.length ? needle ? "No matching notes." : "This folder is empty." : "No recordings yet."}</div>` : "");
    for (const button of list.querySelectorAll("[data-open-folder]")) button.addEventListener("click", () => openFolder(button.dataset.openFolder));
    for (const button of list.querySelectorAll("[data-id]")) button.addEventListener("click", () => openMeeting(button.dataset.id));
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

  function renderDetail(detail) {
    const root = $("#note-detail");
    if (!root) return;
    const meeting = detail.meeting;
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
      <div class="note-folder-control"><label class="field-label" for="note-folder">Folder</label><select class="select-input" id="note-folder">${folderOptions(meeting.folderId)}</select><button type="button" class="small-button" id="move-note">Move note</button></div>
      <section class="note-section"><h3>Summary</h3><div class="summary-text">${esc(meeting.summary || (meeting.status === "recording" ? "Recording is in progress. Stop the recording to prepare your notes." : "Summary is not available yet."))}</div></section>
      ${meeting.actionItems.length ? `<section class="note-section"><h3>Action items</h3><ul class="action-list">${meeting.actionItems.map((item) => `<li>${item.status === "done" ? `<span class="fine-print">Done · </span>` : ""}${esc(item.text)}${item.owner ? ` <span class="fine-print">— ${esc(item.owner)}</span>` : ""}</li>`).join("")}</ul></section>` : ""}
      <section class="note-section"><h3>Transcript</h3><div class="transcript-list">${detail.transcript.length ? detail.transcript.map((segment) => `<p class="transcript-item">${segment.timestamp ? `<time class="fine-print">${esc(prettySegmentTime(segment.timestamp))}</time> ` : ""}<strong>${esc(segment.speaker)}</strong>${esc(segment.text)}</p>`).join("") : '<p class="fine-print">Transcript is not available yet.</p>'}</div></section>
      ${importNotice}
      ${meeting.canReprocessExtensionAudio ? `<section class="recovery-actions"><p class="privacy-note">Create a separate desktop note from the saved audio. The imported transcript and summary will stay unchanged.</p><button class="secondary-button" id="reprocess-extension-audio" ${state.reprocessingIds.has(meeting.id) ? "disabled" : ""}>${state.reprocessingIds.has(meeting.id) ? "Preparing audio copy…" : "Create notes from saved audio"}</button></section>` : ""}
      ${meeting.status === "recovered" && !meeting.textOnlyImport ? `<section class="recovery-actions"><p class="privacy-note">Audio is safe on this device. Resume processing it to finish the transcript and notes.</p><button class="secondary-button" id="recover-meeting" ${state.recoveringIds.has(meeting.id) ? "disabled" : ""}>${state.recoveringIds.has(meeting.id) ? "Recovering notes…" : "Recover notes from saved audio"}</button></section>` : ""}
      <div class="note-actions"><button class="secondary-button" id="delete-note">${meeting.textOnlyImport ? "Delete imported note" : "Delete recording"}</button></div>`;
    $("#delete-note")?.addEventListener("click", deleteMeeting);
    $("#recover-meeting")?.addEventListener("click", recoverMeeting);
    $("#reprocess-extension-audio")?.addEventListener("click", reprocessExtensionAudio);
    $("#move-note")?.addEventListener("click", async () => {
      const destination = $("#note-folder").value || null;
      if (destination === (meeting.folderId || null)) return;
      try {
        await invoke("desktop_move_meeting", { meetingId: meeting.id, folderId: destination });
        state.currentFolderId = destination;
        notify("Recording moved. Its audio remains in the local recording store.");
        await refresh();
      } catch (error) { notify(String(error), "error"); }
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
    button.textContent = "Recovering notes…";
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
    try {
      await invoke("desktop_delete_meeting", { meetingId: id });
      state.selectedId = null;
      state.detail = null;
      notify("Recording deleted from this device.");
      await refresh();
    } catch (error) { notify(String(error), "error"); }
  }

  const keyFields = [
    { id: "deepgram", label: "Deepgram", description: "Transcription", saved: "hasDeepgramKey" },
    { id: "groq", label: "Groq", description: "Transcription", saved: "hasGroqKey" },
    { id: "claude", label: "Anthropic Claude", description: "Summaries", saved: "hasClaudeKey" },
    { id: "gemini", label: "Google Gemini", description: "Summaries", saved: "hasGeminiKey" },
    { id: "deepseek", label: "DeepSeek", description: "Summaries", saved: "hasDeepseekKey" },
  ];

  function renderSettings() {
    setHeader("Settings", "LOCAL APP SETTINGS");
    const s = state.snapshot.settings;
    const p = s.preferences;
    const vocabulary = Array.isArray(p.customVocabulary) ? p.customVocabulary.join("\n") : "";
    const transcription = `<option value="deepgram" ${p.transcriptionProvider === "deepgram" ? "selected" : ""}>Deepgram</option><option value="groq" ${p.transcriptionProvider === "groq" ? "selected" : ""}>Groq</option>`;
    const summarization = `<option value="claude" ${p.summarizationProvider === "claude" ? "selected" : ""}>Claude</option><option value="gemini" ${p.summarizationProvider === "gemini" ? "selected" : ""}>Gemini</option><option value="deepseek" ${p.summarizationProvider === "deepseek" ? "selected" : ""}>DeepSeek</option>`;
    const modes = `<option value="general" ${p.defaultMeetingMode === "general" ? "selected" : ""}>General</option><option value="standup" ${p.defaultMeetingMode === "standup" ? "selected" : ""}>Stand-up</option><option value="sales" ${p.defaultMeetingMode === "sales" ? "selected" : ""}>Sales</option><option value="one_on_one" ${p.defaultMeetingMode === "one_on_one" ? "selected" : ""}>1:1</option><option value="interview" ${p.defaultMeetingMode === "interview" ? "selected" : ""}>Interview</option><option value="lecture" ${p.defaultMeetingMode === "lecture" ? "selected" : ""}>Lecture</option><option value="custom" ${p.defaultMeetingMode === "custom" ? "selected" : ""}>Custom</option>`;
    let providerKeyMarkup = "";
    keyFields.forEach((key) => {
      providerKeyMarkup += `<div class="form-field"><label class="field-label" for="key-${key.id}">${key.label} <span class="fine-print">· ${key.description}</span></label><div class="key-row"><input class="text-input" id="key-${key.id}" type="password" autocomplete="new-password" placeholder="${s[key.saved] ? "Saved securely · blank keeps current key" : "Paste API key"}" /><button type="button" class="secondary-button test-key" data-provider="${key.id}">Check</button></div><label class="key-status" id="key-status-${key.id}">${s[key.saved] ? "A key is saved securely on this device." : "No key saved."}</label><label class="fine-print"><input type="checkbox" id="clear-${key.id}" /> Remove saved key</label></div>`;
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
    $("#content").innerHTML = `<div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections"><button type="button" data-settings-section="providers" aria-current="true">AI providers</button><button type="button" data-settings-section="note-style">Notes &amp; language</button><button type="button" data-settings-section="sync">Web app sync</button><button type="button" data-settings-section="import">Import data</button></nav><form id="settings-form" class="settings-stack">
      ${state.snapshot.credentialStoreError ? `<div class="setup-callout"><span aria-hidden="true">ⓘ</span><div><strong>Secure storage is unavailable</strong><span>${esc(state.snapshot.credentialStoreError)}</span></div></div>` : ""}
      <section class="card settings-card" id="settings-providers"><h2 tabindex="-1">AI providers</h2><p>Use your provider API keys. They are stored in your operating system’s credential store.</p>
        <div class="form-grid"><div class="form-field"><label class="field-label" for="transcription-provider">Transcription provider</label><select class="select-input" id="transcription-provider">${transcription}</select></div><div class="form-field"><label class="field-label" for="summarization-provider">Summary provider</label><select class="select-input" id="summarization-provider">${summarization}</select></div>
        ${providerKeyMarkup}</div>
      </section>
      <section class="card settings-card" id="settings-note-style"><h2 tabindex="-1">Notes &amp; language</h2><p>Choose the default summary style and words your providers should recognize.</p><div class="form-grid">
        <div class="form-field wide"><label class="field-label" for="meeting-mode">Default meeting style</label><select class="select-input" id="meeting-mode">${modes}</select></div>
        <div class="form-field wide"><label class="field-label" for="vocabulary">Custom vocabulary <span class="fine-print">one term per line</span></label><textarea class="text-area" id="vocabulary" placeholder="Product names, acronyms, and people">${esc(vocabulary)}</textarea></div>
        <div class="form-field wide"><label class="field-label" for="instructions">Summary instructions <span class="fine-print">optional</span></label><textarea class="text-area" id="instructions" maxlength="4000" placeholder="What should summaries focus on?">${esc(p.customSummaryInstructions)}</textarea></div></div>
      </section>
      <section class="card settings-card" id="settings-sync"><h2 tabindex="-1">Web app sync</h2><p>Optional. Local recording works without an account. Upload finished desktop notes to a workspace and bring notes from the web app into this library.</p>
        <div class="form-grid"><div class="form-field wide"><label class="field-label" for="webapp-url">Web-app URL</label><input class="text-input" id="webapp-url" type="url" value="${esc(p.webappUrl)}" placeholder="https://notes.example.com" autocomplete="url" /></div>
        <div class="form-field wide"><label class="field-label" for="webapp-token">Desktop sync token</label><div class="key-row"><input class="text-input" id="webapp-token" type="password" autocomplete="new-password" placeholder="${s.hasWebappToken ? "Saved securely · blank keeps current token" : "Paste desktop sync token"}" /><button type="button" class="secondary-button" id="test-webapp">Test connection</button></div><label class="key-status" id="webapp-status">${s.hasWebappToken ? (state.snapshot.webappSync.configured ? `Sync enabled · ${state.snapshot.webappSync.pending} note(s) pending` : "Token saved. Check the URL and connection.") : "No sync token saved."}</label><label class="fine-print"><input type="checkbox" id="clear-webapp-token" /> Remove saved token</label></div></div>
        <div class="privacy-note"><p>To connect, sign in to the web app, create a “Desktop note sync” token in Settings → Integrations, and paste it here.</p><p>Finished desktop notes upload to the selected workspace. Notes created in the web app are copied here and updated on the next sync. Web edits do not change recordings made on this desktop. Note deletions and settings do not sync between the desktop and web app.</p><p>This workspace sync sends notes only; it does not send raw audio or provider keys. Import extension recordings from an archive.</p></div>
        ${conflictMarkup}
        ${state.snapshot.webappSync.configured || conflicts.length ? `<p class="key-status" id="sync-status" role="status" aria-live="polite">${esc(state.syncInProgress ? "Syncing desktop notes and web app notes…" : state.syncAnnouncement)}</p>` : ""}
        ${state.snapshot.webappSync.configured ? `<div class="sync-controls"><span class="fine-print">${state.snapshot.webappSync.lastSuccessAt ? `Last desktop upload ${esc(prettyDate(state.snapshot.webappSync.lastSuccessAt))}` : "Web app notes update when sync runs"}${state.snapshot.webappSync.lastError ? ` · ${esc(state.snapshot.webappSync.lastError)}` : ""}</span><div class="inline-actions"><button type="button" class="secondary-button" id="sync-existing" ${state.syncInProgress ? "disabled" : ""}>Sync existing desktop notes</button><button type="button" class="small-button" id="retry-sync" ${state.syncInProgress ? "disabled" : ""}>${state.syncInProgress ? "Syncing…" : "Sync now"}${!state.syncInProgress && state.snapshot.webappSync.pending ? ` · ${state.snapshot.webappSync.pending} note(s) queued` : ""}</button></div>${state.snapshot.webappSync.separateCopies ? `<p class="fine-print">${state.snapshot.webappSync.separateCopies} note copy/copies are kept separate from a workspace.</p>` : ""}<p class="fine-print">Sync now uploads pending desktop notes and updates notes copied from the web app.</p></div>` : ""}
      </section>
      <section class="card settings-card" id="settings-import"><h2 tabindex="-1">Import from the extension</h2><p>Import a full archive to bring over new browser meeting recordings, older notes, partial transcripts, and any raw audio still saved by the extension. Older completed-call audio may already have been removed after notes were saved. API keys, web-app credentials, and Google connections stay separate. Import copies data; it never removes the extension source.</p>
        <button type="button" class="secondary-button" id="import-desktop-audio-transfer">Choose full archive</button>
        <p class="key-status" id="desktop-audio-transfer-status" role="status" aria-live="polite"></p>
        <p class="fine-print">Older notes-only JSON transfer files can still be imported below.</p>
        <input id="desktop-transfer-file" type="file" accept=".json,application/json" hidden />
        <button type="button" class="secondary-button" id="choose-desktop-transfer">Import notes-only file</button>
        <p class="key-status" id="desktop-transfer-status" role="status" aria-live="polite"></p>
      </section>
      <div class="settings-footer"><span class="settings-hint">Blank credential fields keep saved values.</span><button type="submit" class="primary-button" id="save-settings">Save settings</button></div>
    </form></div>`;
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#settings-form").addEventListener("input", () => { state.settingsDirty = true; });
    $("#settings-form").addEventListener("change", () => { state.settingsDirty = true; });
    for (const button of document.querySelectorAll(".test-key")) button.addEventListener("click", () => testKey(button.dataset.provider));
    $("#test-webapp")?.addEventListener("click", testWebapp);
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
        await invoke("desktop_resolve_webapp_conflict", {
          conflictKey: button.dataset.syncConflict,
          resolution,
        });
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
    if (!key) { status.textContent = "Paste a key to check it."; status.className = "key-status error"; return; }
    status.textContent = "Checking with provider…";
    status.className = "key-status";
    try {
      const result = await invoke("desktop_test_provider_key", { provider, key });
      status.textContent = result.message;
      status.className = `key-status ${result.valid ? "ok" : "error"}`;
    } catch (error) { status.textContent = String(error); status.className = "key-status error"; }
  }

  async function testWebapp() {
    const status = $("#webapp-status");
    const token = $("#webapp-token").value.trim();
    if (!token && !state.snapshot.settings.hasWebappToken) { status.textContent = "Paste a desktop sync token first."; status.className = "key-status error"; return; }
    status.textContent = "Checking connection…";
    status.className = "key-status";
    try {
      const result = await invoke("desktop_test_webapp", { url: $("#webapp-url").value.trim(), token });
      status.textContent = result.message;
      status.className = `key-status ${result.valid ? "ok" : "error"}`;
    } catch (error) { status.textContent = String(error); status.className = "key-status error"; }
  }

  async function syncExisting() {
    state.syncInProgress = true;
    state.syncAnnouncement = "";
    updateSyncFeedback();
    try { const count = await invoke("desktop_sync_existing_notes"); notify(`Queued ${count} finished note${count === 1 ? "" : "s"} for sync.`); await refresh(); }
    catch (error) { state.syncInProgress = false; state.syncAnnouncement = `Sync could not start: ${String(error)}`; updateSyncFeedback(); notify(String(error), "error"); }
  }

  async function retrySync() {
    state.syncInProgress = true;
    state.syncAnnouncement = "";
    updateSyncFeedback();
    try { await invoke("desktop_retry_webapp_sync"); await refresh(); }
    catch (error) { state.syncInProgress = false; state.syncAnnouncement = `Sync could not start: ${String(error)}`; updateSyncFeedback(); notify(String(error), "error"); }
  }

  function updateSyncFeedback() {
    const status = $("#sync-status");
    if (status) status.textContent = state.syncInProgress
      ? "Syncing desktop notes and importing workspace notes…"
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
    button.disabled = true;
    const payload = {
      transcriptionProvider: $("#transcription-provider").value,
      summarizationProvider: $("#summarization-provider").value,
      defaultMeetingMode: $("#meeting-mode").value,
      customVocabulary: $("#vocabulary").value.split("\n"),
      customSummaryInstructions: $("#instructions").value,
      webappUrl: $("#webapp-url").value.trim(),
      webappToken: $("#clear-webapp-token").checked ? "" : $("#webapp-token").value || null,
    };
    for (const key of keyFields) payload[`${key.id}Key`] = $(`#clear-${key.id}`).checked ? "" : $(`#key-${key.id}`).value || null;
    try {
      await invoke("desktop_save_settings", { input: payload });
      state.settingsDirty = false;
      notify("Settings saved securely on this device.");
      await refresh();
    } catch (error) { notify(String(error), "error"); }
    finally { button.disabled = false; }
  }

  document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  $("#open-notes-folder").addEventListener("click", async () => { try { await invoke("desktop_open_notes_folder"); } catch (error) { notify(String(error), "error"); } });
  $("#open-webapp").addEventListener("click", async () => { try { await invoke("desktop_open_webapp"); } catch (error) { notify(String(error), "error"); } });

  if (!invoke) {
    $("#content").innerHTML = '<div class="empty-state"><strong>Desktop bridge unavailable</strong>Open AI Notetaker from its installed desktop app.</div>';
    return;
  }
  if (listen) listen("helper-message", (event) => {
    const message = event.payload;
    if (message?.type === "error") {
      if (message.meetingId) state.recoveringIds.delete(message.meetingId);
      notify(message.message || "The helper reported an error.", "error");
      refresh();
    } else if (["recording_started", "recording_stopped", "summary_ready", "recovered_recording", "audio_status", "audio_probe_result"].includes(message?.type)) {
      if (message?.type === "summary_ready" && message.meetingId) state.recoveringIds.delete(message.meetingId);
      refresh();
    }
  }).catch(() => {});
  if (listen) listen("webapp-sync-updated", (event) => {
    state.syncInProgress = false;
    const error = event.payload?.lastError;
    state.syncAnnouncement = error ? `Sync finished with an issue: ${error}` : "Sync complete.";
    updateSyncFeedback();
    void refresh();
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
      if (refreshTask === null && !state.busy && state.page !== "settings") void refresh();
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
