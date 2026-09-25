"use client";

import * as Sentry from "@sentry/nextjs";
import { Component, type ReactNode } from "react";

/**
 * Client-side error reporting. Enabled only when NEXT_PUBLIC_SENTRY_DSN is set
 * at build time (the managed deployment); a self-hosted build has no DSN, so
 * this component renders children untouched and nothing is ever sent.
 *
 * Boundary-local instead of global: Next.js already routes unexpected render
 * errors through error.tsx/global-error.tsx (which report through this same
 * gate); this boundary adds reporting for interactive failures — the share
 * page's copy/print controls, the recording player, action-item edits —
 * where the page keeps working but one control dies.
 */
export class ReportingErrorBoundary extends Component<{ children: ReactNode; area: string }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; area: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    try {
      Sentry.captureException(error, { tags: { area: this.props.area } });
    } catch {
      // never break rendering further
    }
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
