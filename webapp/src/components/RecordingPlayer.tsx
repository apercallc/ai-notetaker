"use client";

import { useState } from "react";

const CHANNEL_LABEL = { speaker: "Others", mic: "You" } as const;

/**
 * The native audio element on the recording route. `preload="none"` so a
 * page view never downloads audio; the route honours Range, so seeking
 * doesn't restart the download.
 */
export function RecordingPlayer({ meetingId, channels }: { meetingId: string; channels: ("mic" | "speaker")[] }) {
  const ordered = (["speaker", "mic"] as const).filter((channel) => channels.includes(channel));
  const [channel, setChannel] = useState<"mic" | "speaker">(ordered[0] ?? "speaker");
  if (ordered.length === 0) return null;

  return (
    <div className="recording-player">
      {ordered.length > 1 && (
        <div className="segmented" role="group" aria-label="Recording channel">
          {ordered.map((option) => (
            <button
              key={option}
              type="button"
              className={option === channel ? "is-selected" : undefined}
              aria-pressed={option === channel}
              onClick={() => setChannel(option)}
            >
              {CHANNEL_LABEL[option]}
            </button>
          ))}
        </div>
      )}
      <audio
        key={channel}
        controls
        preload="none"
        src={`/meetings/${encodeURIComponent(meetingId)}/recording?channel=${channel}`}
        aria-label={`Recording of ${CHANNEL_LABEL[channel] === "You" ? "your microphone" : "everyone else"}`}
      >
        Your browser can&apos;t play audio here. Use the download buttons instead.
      </audio>
    </div>
  );
}
