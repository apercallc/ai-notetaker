/** Real Chromium media/extension smoke; synthetic Meet origin, no accounts/providers. */
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = await mkdtemp(path.join(tmpdir(), "notetaker-direct-smoke-"));
const extension = path.join(temp, "extension");
let context;
try {
  await cp(path.join(root, "dist"), extension, { recursive: true });
  // Test-only introspection for failures; never included in the production build.
  const mainPath = path.join(extension, "content/directMain.js");
  const main = await readFile(mainPath, "utf8");
  await writeFile(mainPath, main.replace("const source = new DirectMeetSource(NativePeer);", "const source = new DirectMeetSource(NativePeer); window.__smokeSource = source;"));
  // Use the production capture controller, offscreen recorder, bridge, and
  // IndexedDB implementation. Replace only provider/product orchestration.
  await build({ stdin: { resolveDir: root, contents: `
    import { MeetCaptureController } from './src/meet/meetCapture';
    import { appendBrowserMeetChunk, streamBrowserMeetChunks } from './src/meet/browserStorage';
    let sequence = 0;
    let capture = new MeetCaptureController((bytes, id, channel, chunkId) => appendBrowserMeetChunk(id, channel, sequence++, bytes, Date.now(), chunkId));
    globalThis.smokeStart = (tab) => capture.start(tab, 'smoke');
    globalThis.smokeStop = () => capture.stop('smoke');
    globalThis.smokeRecover = async () => { capture = new MeetCaptureController((bytes, id, channel, chunkId) => appendBrowserMeetChunk(id, channel, sequence++, bytes, Date.now(), chunkId)); await capture.restoreCaptures(); };
    globalThis.smokeStats = async () => {
      const stats = {mic: {chunks:0, peak:0}, speaker: {chunks:0, peak:0}};
      for await (const chunk of streamBrowserMeetChunks('smoke')) {
        const channel = stats[chunk.channel]; channel.chunks++;
        const view = new DataView(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
        for (let i=0;i<view.byteLength;i+=2) channel.peak = Math.max(channel.peak, Math.abs(view.getInt16(i,true)));
      }
      return stats;
    };
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.url !== chrome.runtime.getURL('meet/offscreen.html')) return false;
      let task;
      if (message.type === 'MEET_DIRECT_ANSWER') task = capture.answerDirect(message.meetingId,message.sdp).then(()=>({ok:true}));
      else if (message.type === 'MEET_AUDIO_CHUNK') task = Promise.resolve(capture.forwardChunk(message)).then(()=>({ok:true}));
      else if (message.type === 'MEET_CAPTURE_ERROR') { console.error(message.message); task = capture.stop(message.meetingId); }
      else return false;
      task.then(reply, error => reply({error:String(error)})); return true;
    });
  ` }, bundle: true, format: "esm", outfile: path.join(extension, "background.js") });
  await writeFile(path.join(extension, "test-controls.html"), "<!doctype html><title>Microphone setup</title>");
  context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio", "--no-sandbox"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/test-controls.html`);
  await setup.evaluate(async () => { const mic = await navigator.mediaDevices.getUserMedia({audio:true}); mic.getTracks().forEach(t=>t.stop()); });
  await setup.close();
  await context.route("https://meet.google.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Synthetic Meet</title><button id="join">Join synthetic call</button><script>
    document.querySelector('#join').onclick = async () => {
      const context = new AudioContext(); await context.resume();
      const tone = context.createOscillator(); tone.frequency.value = 440;
      const mix = context.createMediaStreamDestination(); tone.connect(mix); tone.start();
      const sender = new RTCPeerConnection({iceServers:[]}), receiver = new RTCPeerConnection({iceServers:[]});
      receiver.ontrack = ({track}) => { const audio = document.createElement('audio'); audio.srcObject = new MediaStream([track]); document.body.append(audio); audio.play(); };
      sender.onicecandidate = e => { if(e.candidate) receiver.addIceCandidate(e.candidate); };
      receiver.onicecandidate = e => { if(e.candidate) sender.addIceCandidate(e.candidate); };
      sender.addTransceiver(mix.stream.getAudioTracks()[0], {direction:'sendonly'});
      await sender.setLocalDescription(await sender.createOffer()); await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer()); await sender.setRemoteDescription(receiver.localDescription);
      window.call = {context,tone,mix,sender,receiver};
    };
  </script>` }));
  const page = await context.newPage();
  await page.goto("https://meet.google.com/abc-defg-hij");
  await page.click("#join");
  await page.waitForFunction(() => window.call?.receiver.connectionState === "connected");
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({url:"https://meet.google.com/*"}))[0].id);
  // Prove the fallback would fail: this tab has never invoked the extension.
  const permissionError = await worker.evaluate(async tabId => {
    try { await chrome.tabCapture.getMediaStreamId({targetTabId:tabId}); return null; }
    catch(error) { return error.message; }
  }, tabId);
  assert.match(permissionError ?? "", /invoked|activeTab/i);
  await worker.evaluate(tabId => globalThis.smokeStart(tabId), tabId);
  const active = await worker.evaluate(async () => (await chrome.storage.session.get("meet-active-captures"))["meet-active-captures"]);
  assert.ok(active[0][1].directSession, "direct path must be active");
  // Poll durable storage, not an in-memory stream counter.
  let stats;
  for (let i=0;i<30;i++) {
    stats = await worker.evaluate(() => globalThis.smokeStats());
    if (stats.speaker.chunks >= 3 && stats.mic.chunks >= 3 && stats.speaker.peak > 100 && stats.mic.peak > 100) break;
    await page.waitForTimeout(250);
  }
  if (stats.speaker.peak === 0) console.log(await page.evaluate(async () => ({
    callState: window.call.context.state,
    call: [...(await window.call.receiver.getStats()).values()].filter(s => s.type === 'inbound-rtp'),
    source: window.__smokeSource ? {context:window.__smokeSource.context?.state, sources:window.__smokeSource.sources.size, relay:[...(await window.__smokeSource.relay.getStats()).values()].filter(s=>s.type==='outbound-rtp'), tracks:[...window.__smokeSource.sources.keys()].map(t=>({muted:t.muted,enabled:t.enabled,state:t.readyState}))} : null,
  })));
  assert.ok(stats.speaker.chunks >= 3 && stats.speaker.peak > 100, JSON.stringify(stats));
  assert.ok(stats.mic.chunks >= 3 && stats.mic.peak > 100, JSON.stringify(stats));
  await worker.evaluate(() => globalThis.smokeRecover());
  await worker.evaluate(() => globalThis.smokeStop());
  assert.equal(await page.evaluate(() => window.call.receiver.getReceivers()[0].track.readyState), "live", "stopping notes must not stop Meet audio");
  // Exercise another recording in the same call after teardown.
  await worker.evaluate(tabId => globalThis.smokeStart(tabId), tabId);
  await worker.evaluate(() => globalThis.smokeStop());
  console.log(JSON.stringify({passed:true, noToolbarGrant:true, directCapture:true, durableAudio:stats, restoreAndStop:true, restart:true}));
} finally {
  await context?.close();
  await rm(temp, {recursive:true, force:true});
}
