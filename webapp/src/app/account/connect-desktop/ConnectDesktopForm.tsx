"use client";

import { useActionState, useState } from "react";
import { createDesktopConnectCode, type ConnectCodeResult } from "./actions";

export function ConnectDesktopForm() {
  const [result, action, pending] = useActionState<ConnectCodeResult | null, FormData>(() => createDesktopConnectCode(), null);
  const [copied, setCopied] = useState(false);
  return (
    <form action={action} className="settings-card">
      <button className="button button-primary" type="submit" disabled={pending}>{pending ? "Creating…" : result?.ok ? "Create a new code" : "Create sign-in code"}</button>
      {result && !result.ok && <p className="error-text" role="alert">{result.error}</p>}
      {result?.ok && (
        <div>
          <p className="muted-copy" role="status">Paste this code into the desktop app within {result.minutes} minutes. It works once.</p>
          <input aria-label="Desktop sign-in code" className="text-input" readOnly value={result.code} onFocus={(event) => event.target.select()} />
          <button
            type="button"
            className="button button-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.code);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
        </div>
      )}
    </form>
  );
}
