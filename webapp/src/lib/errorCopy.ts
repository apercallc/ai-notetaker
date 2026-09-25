// Route-appropriate error-boundary copy. "Your notes are safe" is only a
// fair thing to say on pages that just *read* notes — it would be an odd
// reassurance for a billing failure, where the real worry is money.

export interface ErrorCopy {
  title: string;
  body: string;
  backHref: string;
  backLabel: string;
}

export function errorCopyForPath(pathname: string | null): ErrorCopy {
  const path = pathname ?? "";
  if (path.startsWith("/billing")) {
    return {
      title: "We couldn't load Plans & usage",
      body: "Your plan and any payment in progress are unchanged. Try again, or come back in a minute.",
      backHref: "/meetings",
      backLabel: "Back to meetings",
    };
  }
  if (path.startsWith("/team")) {
    return {
      title: "We couldn't load your team",
      body: "No membership or workspace settings were changed. Try again in a moment.",
      backHref: "/meetings",
      backLabel: "Back to meetings",
    };
  }
  if (path.startsWith("/account")) {
    return {
      title: "We couldn't load your account",
      body: "Nothing on your account was changed. Try again in a moment.",
      backHref: "/meetings",
      backLabel: "Back to meetings",
    };
  }
  if (path.startsWith("/login")) {
    return {
      title: "We couldn't load sign in",
      body: "Try again. If the problem continues, reload the page.",
      backHref: "/login",
      backLabel: "Reload sign in",
    };
  }
  if (path.startsWith("/actions")) {
    return {
      title: "We couldn't load your action items",
      body: "Your saved items are unaffected. Try again in a moment.",
      backHref: "/meetings",
      backLabel: "Back to meetings",
    };
  }
  return {
    title: "Something went wrong",
    body: "Your saved meetings are unaffected. Try again in a moment.",
    backHref: "/meetings",
    backLabel: "Back to meetings",
  };
}
