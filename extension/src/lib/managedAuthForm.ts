import { escapeHtml } from "./html";

/** Shared Hosted AI sign-in controls so onboarding and Settings stay in sync. */
export function renderManagedSignInControls(options: { prefix: string; email: string; withinForm?: boolean }): string {
  const { prefix } = options;
  const emailId = `${prefix}-email`;
  const passwordId = `${prefix}-password`;
  const wrapper = options.withinForm ? "div" : "form";
  const submitType = options.withinForm ? "button" : "submit";
  return `
    <div class="managed-auth">
      <button type="button" class="primary managed-google-button" id="${prefix}-google-sign-in">Continue with Google</button>
      <p class="managed-auth-divider"><span>or sign in with email</span></p>
      <${wrapper} class="managed-auth-form" id="${prefix}-email-form">
        <div class="field"><label for="${emailId}">Account email</label><input type="email" id="${emailId}" autocomplete="username" value="${escapeHtml(options.email)}" required /></div>
        <div class="field"><label for="${passwordId}">Account password</label><input type="password" id="${passwordId}" autocomplete="current-password" required /></div>
        <div class="managed-auth-actions">
          <button type="${submitType}" class="secondary" id="${prefix}-sign-in">Sign in with email</button>
          <button type="button" class="secondary" id="${prefix}-signup">Create an account</button>
        </div>
      </${wrapper}>
      <p class="test-result" id="${prefix}-result" role="status" aria-live="polite"></p>
    </div>`;
}
