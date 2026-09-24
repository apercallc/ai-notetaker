import type { ActionItem, BrowserAudioChannel, MeetingMode, NotetakerSettings, ProviderKind, TranscriptSegment } from "../types";

export interface BrowserMeetChunk {
  channel: BrowserAudioChannel;
  sequence: number;
  bytes: Uint8Array;
}

export interface BrowserMeetResult {
  transcript: TranscriptSegment[];
  summary: string;
  actionItems: ActionItem[];
}

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

function providerError(response: Response, provider: string): Error {
  return new Error(`${provider} returned ${response.status}`);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 5_000);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, 2_000);
}

function waitForRetry(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      if (response.ok || !retryableStatus(response.status) || attempt === REQUEST_MAX_ATTEMPTS - 1) return response;
      await waitForRetry(retryDelayMs(attempt, response));
    } catch (error) {
      if (attempt === REQUEST_MAX_ATTEMPTS - 1) throw error;
      await waitForRetry(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Provider request failed");
}

function bytesForChannel(chunks: BrowserMeetChunk[], channel: BrowserAudioChannel): Uint8Array {
  const selected = chunks.filter((chunk) => chunk.channel === channel).sort((a, b) => a.sequence - b.sequence);
  const total = selected.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of selected) {
    result.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return result;
}

function speakerForChannel(channel: BrowserAudioChannel): "you" | "them" {
  return channel === "mic" ? "you" : "them";
}

function transcriptFromDeepgram(body: Record<string, unknown>, channel: BrowserAudioChannel): TranscriptSegment[] {
  const speaker = speakerForChannel(channel);
  const results = body.results as Record<string, unknown> | undefined;
  const utterances = results?.utterances;
  if (Array.isArray(utterances)) {
    const parsed = utterances
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        speaker,
        text: typeof item.transcript === "string" ? item.transcript.trim() : "",
        timestamp: new Date(typeof item.start === "number" ? item.start * 1000 : 0).toISOString(),
        isFinal: true,
      }))
      .filter((item) => item.text.length > 0);
    if (parsed.length > 0) return parsed;
  }
  const transcript = (results?.channels as unknown[])?.[0];
  const text = typeof (transcript as Record<string, unknown> | undefined)?.alternatives === "object"
    ? ((transcript as Record<string, unknown>).alternatives as unknown[])?.[0]
    : undefined;
  const textRecord = text as Record<string, unknown> | undefined;
  const value = typeof textRecord?.transcript === "string" ? textRecord.transcript.trim() : "";
  return value
    ? [{ speaker, text: value, timestamp: new Date().toISOString(), isFinal: true }]
    : [];
}

async function transcribeDeepgram(bytes: Uint8Array, channel: BrowserAudioChannel, key: string, fetchImpl: typeof fetch): Promise<TranscriptSegment[]> {
  const url = `${DEEPGRAM_URL}?encoding=linear16&sample_rate=48000&channels=1&model=nova-3&punctuate=true&diarize=true&utterances=true`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "audio/l16" },
    body: bytes.buffer as ArrayBuffer,
  });
  if (!response.ok) throw providerError(response, "Deepgram");
  return transcriptFromDeepgram((await response.json()) as Record<string, unknown>, channel);
}

async function transcribeGroq(bytes: Uint8Array, channel: BrowserAudioChannel, key: string, fetchImpl: typeof fetch): Promise<TranscriptSegment[]> {
  const form = new FormData();
  form.append("file", new Blob([bytes.slice().buffer as ArrayBuffer], { type: "audio/l16" }), "meet-audio.raw");
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");
  const response = await fetchWithTimeout(fetchImpl, GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) throw providerError(response, "Groq");
  const body = (await response.json()) as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  return text ? [{ speaker: speakerForChannel(channel), text, timestamp: new Date().toISOString(), isFinal: true }] : [];
}

function renderTranscript(transcript: TranscriptSegment[]): string {
  return transcript.map((segment) => `${segment.speaker === "you" ? "You" : "Them"}: ${segment.text}`).join("\n");
}

function summaryPrompt(mode: MeetingMode, transcript: TranscriptSegment[]): string {
  return `You are summarizing a ${mode} meeting. Return ONLY valid JSON with this shape: {"summary": string, "action_items": [{"text": string, "owner": string | null}]}. Keep the summary concise and make action items concrete.\n\n${renderTranscript(transcript)}`;
}

function parseSummary(text: string): Pick<BrowserMeetResult, "summary" | "actionItems"> {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as { summary?: unknown; action_items?: unknown };
  const actionItems = Array.isArray(parsed.action_items)
    ? parsed.action_items
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && typeof item.text === "string")
        .slice(0, 100)
        .map((item) => ({ text: item.text as string, ...(typeof item.owner === "string" ? { owner: item.owner } : {}) }))
    : [];
  return { summary: typeof parsed.summary === "string" ? parsed.summary : "", actionItems };
}

async function summarizeClaude(transcript: TranscriptSegment[], mode: MeetingMode, key: string, fetchImpl: typeof fetch): Promise<Pick<BrowserMeetResult, "summary" | "actionItems">> {
  const response = await fetchWithTimeout(fetchImpl, CLAUDE_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1024, messages: [{ role: "user", content: summaryPrompt(mode, transcript) }] }),
  });
  if (!response.ok) throw providerError(response, "Claude");
  const body = (await response.json()) as Record<string, unknown>;
  const text = (((body.content as unknown[])?.[0] as Record<string, unknown> | undefined)?.text);
  if (typeof text !== "string") throw new Error("Claude returned no summary");
  return parseSummary(text);
}

async function summarizeGemini(transcript: TranscriptSegment[], mode: MeetingMode, key: string, fetchImpl: typeof fetch): Promise<Pick<BrowserMeetResult, "summary" | "actionItems">> {
  const response = await fetchWithTimeout(fetchImpl, `${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: summaryPrompt(mode, transcript) }] }] }),
  });
  if (!response.ok) throw providerError(response, "Gemini");
  const body = (await response.json()) as Record<string, unknown>;
  const text = (((body.candidates as unknown[])?.[0] as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)?.parts;
  const value = Array.isArray(text) ? (text[0] as Record<string, unknown> | undefined)?.text : undefined;
  if (typeof value !== "string") throw new Error("Gemini returned no summary");
  return parseSummary(value);
}

async function summarizeDeepSeek(transcript: TranscriptSegment[], mode: MeetingMode, key: string, fetchImpl: typeof fetch): Promise<Pick<BrowserMeetResult, "summary" | "actionItems">> {
  const response = await fetchWithTimeout(fetchImpl, DEEPSEEK_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: summaryPrompt(mode, transcript) }], response_format: { type: "json_object" } }),
  });
  if (!response.ok) throw providerError(response, "DeepSeek");
  const body = (await response.json()) as Record<string, unknown>;
  const value = (((body.choices as unknown[])?.[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content;
  if (typeof value !== "string") throw new Error("DeepSeek returned no summary");
  return parseSummary(value);
}

export async function processBrowserMeetRecording(
  settings: NotetakerSettings,
  meetingMode: MeetingMode,
  chunks: BrowserMeetChunk[],
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserMeetResult> {
  const channels: BrowserAudioChannel[] = ["mic", "speaker"];
  const transcript: TranscriptSegment[] = [];
  for (const channel of channels) {
    const bytes = bytesForChannel(chunks, channel);
    if (bytes.byteLength === 0) continue;
    const key = settings.apiKeys[settings.transcriptionProvider];
    if (!key) throw new Error(`Missing ${settings.transcriptionProvider} API key`);
    const lines = settings.transcriptionProvider === "groq"
      ? await transcribeGroq(bytes, channel, key, fetchImpl)
      : await transcribeDeepgram(bytes, channel, key, fetchImpl);
    transcript.push(...lines);
  }
  transcript.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (transcript.length === 0) throw new Error("No speech was detected in the Meet recording");
  const summaryKey = settings.apiKeys[settings.summarizationProvider];
  if (!summaryKey) throw new Error(`Missing ${settings.summarizationProvider} API key`);
  const summary = settings.summarizationProvider === "claude"
    ? await summarizeClaude(transcript, meetingMode, summaryKey, fetchImpl)
    : settings.summarizationProvider === "gemini"
      ? await summarizeGemini(transcript, meetingMode, summaryKey, fetchImpl)
      : await summarizeDeepSeek(transcript, meetingMode, summaryKey, fetchImpl);
  return { transcript, ...summary };
}

export function providerSupportsBrowserMeet(provider: ProviderKind): boolean {
  return provider === "deepgram" || provider === "groq" || provider === "claude" || provider === "gemini" || provider === "deepseek";
}
