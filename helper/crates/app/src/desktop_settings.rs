//! Desktop-owned preferences. Secrets live in the platform credential store;
//! this JSON file contains only provider choices and non-secret preferences.

use notetaker_core::native_messaging::{
    ApiKeys, ManagedServiceConfig, MeetingMode, SummarizationProviderId, TranscriptionProviderId,
    WebappConfig,
};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

const SERVICE: &str = "com.ainotetaker.desktop";
const SETTINGS_FILE: &str = "desktop-settings.json";

pub const DEFAULT_WEBAPP_URL: &str = "https://ai-notetaker.apercallc.com";

/// Non-secret details of the signed-in hosted account. The session token itself lives in
/// the operating system credential store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAccount {
    pub email: String,
    pub base_url: String,
    pub account_id: String,
    pub workspace_id: String,
    pub plan: String,
    pub expires_at: String,
    /// Whether the workspace had cloud sync (a Pro or Team plan) when the app last asked. `None`
    /// for accounts saved before the app tracked it.
    #[serde(default)]
    pub sync_allowed: Option<bool>,
}

impl HostedAccount {
    /// An unparseable expiry is treated as live; the server still rejects a dead session.
    pub fn is_expired(&self) -> bool {
        chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .map(|expires| expires <= chrono::Utc::now())
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub transcription_provider: TranscriptionProviderId,
    pub summarization_provider: SummarizationProviderId,
    pub default_meeting_mode: MeetingMode,
    pub custom_vocabulary: Vec<String>,
    pub custom_summary_instructions: String,
    pub webapp_url: String,
    #[serde(default)]
    pub hosted_account: Option<HostedAccount>,
    /// Cloud sync was connected automatically by signing in (not by a token the user pasted), so
    /// signing out must disconnect it again and leave the app fully offline.
    #[serde(default)]
    pub sync_from_sign_in: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            transcription_provider: TranscriptionProviderId::Deepgram,
            summarization_provider: SummarizationProviderId::Claude,
            default_meeting_mode: MeetingMode::General,
            custom_vocabulary: Vec::new(),
            custom_summary_instructions: String::new(),
            webapp_url: DEFAULT_WEBAPP_URL.to_string(),
            hosted_account: None,
            sync_from_sign_in: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsView {
    pub preferences: DesktopPreferences,
    pub has_deepgram_key: bool,
    pub has_groq_key: bool,
    pub has_claude_key: bool,
    pub has_gemini_key: bool,
    pub has_deepseek_key: bool,
    pub has_webapp_token: bool,
    /// A hosted session exists in the credential store and has not expired.
    pub has_hosted_session: bool,
}

impl DesktopPreferences {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join(SETTINGS_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Self>(&bytes)
                .map_err(|error| format!("Saved desktop settings could not be read: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("Saved desktop settings could not be read: {error}")),
        }
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), String> {
        let destination = data_dir.join(SETTINGS_FILE);
        let temporary = data_dir.join(format!(".{SETTINGS_FILE}.{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("Desktop settings could not be encoded: {error}"))?;
        let result = (|| {
            #[cfg(unix)]
            let mut file = {
                use std::os::unix::fs::OpenOptionsExt;
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?
            };
            #[cfg(not(unix))]
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &destination)
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("Desktop settings could not be saved: {error}"));
        }
        Ok(())
    }
}

pub fn load_api_keys() -> Result<ApiKeys, String> {
    Ok(ApiKeys {
        deepgram: get_secret("provider-deepgram")?,
        groq: get_secret("provider-groq")?,
        claude: get_secret("provider-claude")?,
        gemini: get_secret("provider-gemini")?,
        deepseek: get_secret("provider-deepseek")?,
    })
}

pub fn save_api_keys(keys: &ApiKeys) -> Result<(), String> {
    set_secret("provider-deepgram", keys.deepgram.as_deref())?;
    set_secret("provider-groq", keys.groq.as_deref())?;
    set_secret("provider-claude", keys.claude.as_deref())?;
    set_secret("provider-gemini", keys.gemini.as_deref())?;
    set_secret("provider-deepseek", keys.deepseek.as_deref())
}

pub fn get_webapp_token() -> Result<Option<String>, String> {
    get_secret("webapp-sync-token")
}

pub fn set_webapp_token(token: Option<&str>) -> Result<(), String> {
    set_secret("webapp-sync-token", token)
}

pub fn get_hosted_token() -> Result<Option<String>, String> {
    get_secret("hosted-session-token")
}

pub fn set_hosted_token(token: Option<&str>) -> Result<(), String> {
    set_secret("hosted-session-token", token)
}

/// The signed-in hosted account's connection. Used for account calls (usage, Ask, Team, billing), which only need a live session.
pub fn hosted_session(preferences: &DesktopPreferences) -> Option<ManagedServiceConfig> {
    let account = preferences
        .hosted_account
        .as_ref()
        .filter(|account| !account.is_expired())?;
    let token = get_hosted_token()
        .ok()
        .flatten()
        .filter(|token| !token.trim().is_empty())?;
    Some(ManagedServiceConfig {
        base_url: account.base_url.clone(),
        access_token: token,
        account_id: account.account_id.clone(),
        workspace_id: account.workspace_id.clone(),
        plan: account.plan.clone(),
    })
}

/// Which credentials exist, without their values. Reading the OS credential store can block on a
/// keychain prompt or a D-Bus round trip, and the window asks for a snapshot often, so presence is
/// remembered until a credential is written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CredentialPresence {
    pub deepgram: bool,
    pub groq: bool,
    pub claude: bool,
    pub gemini: bool,
    pub deepseek: bool,
    pub webapp_token: bool,
    pub hosted_token: bool,
}

#[derive(Default)]
struct PresenceCache {
    slot: std::sync::Mutex<Option<CredentialPresence>>,
}

impl PresenceCache {
    /// Returns the remembered presence, or loads it. Failures are never remembered, so unlocking
    /// the keychain is noticed on the next call.
    fn get_or_load(
        &self,
        load: impl FnOnce() -> Result<CredentialPresence, String>,
    ) -> Result<CredentialPresence, String> {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(presence) = *slot {
            return Ok(presence);
        }
        let presence = load()?;
        *slot = Some(presence);
        Ok(presence)
    }

    fn invalidate(&self) {
        *self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

static PRESENCE: std::sync::LazyLock<PresenceCache> =
    std::sync::LazyLock::new(PresenceCache::default);

fn present(secret: Option<String>) -> bool {
    secret.is_some_and(|secret| !secret.trim().is_empty())
}

/// Cached credential presence for the snapshot; see [`CredentialPresence`].
pub fn credential_presence() -> Result<CredentialPresence, String> {
    PRESENCE.get_or_load(|| {
        Ok(CredentialPresence {
            deepgram: present(get_secret("provider-deepgram")?),
            groq: present(get_secret("provider-groq")?),
            claude: present(get_secret("provider-claude")?),
            gemini: present(get_secret("provider-gemini")?),
            deepseek: present(get_secret("provider-deepseek")?),
            webapp_token: present(get_webapp_token()?),
            hosted_token: present(get_hosted_token()?),
        })
    })
}

pub fn settings_view_from_presence(
    preferences: DesktopPreferences,
    presence: CredentialPresence,
) -> DesktopSettingsView {
    let has_hosted_session = preferences
        .hosted_account
        .as_ref()
        .is_some_and(|account| !account.is_expired())
        && presence.hosted_token;
    DesktopSettingsView {
        preferences,
        has_deepgram_key: presence.deepgram,
        has_groq_key: presence.groq,
        has_claude_key: presence.claude,
        has_gemini_key: presence.gemini,
        has_deepseek_key: presence.deepseek,
        has_webapp_token: presence.webapp_token,
        has_hosted_session,
    }
}

pub fn settings_view(
    preferences: DesktopPreferences,
    keys: &ApiKeys,
    has_webapp_token: bool,
) -> DesktopSettingsView {
    let has_hosted_session = preferences
        .hosted_account
        .as_ref()
        .is_some_and(|account| !account.is_expired())
        && get_hosted_token().ok().flatten().is_some();
    DesktopSettingsView {
        preferences,
        has_deepgram_key: keys.deepgram.is_some(),
        has_groq_key: keys.groq.is_some(),
        has_claude_key: keys.claude.is_some(),
        has_gemini_key: keys.gemini.is_some(),
        has_deepseek_key: keys.deepseek.is_some(),
        has_webapp_token,
        has_hosted_session,
    }
}

pub fn wire_webapp_config(url: &str) -> Result<Option<WebappConfig>, String> {
    let Some(url) = normalize_webapp_url(url)? else {
        return Ok(None);
    };
    let token = get_webapp_token()?;
    let Some(token) = token.filter(|token| !token.trim().is_empty()) else {
        return Ok(None);
    };
    Ok(Some(WebappConfig { url, token }))
}

/// True for `localhost` and literal loopback addresses. `host_str` keeps the brackets around an
/// IPv6 literal, so they are trimmed before parsing.
pub fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// https anywhere, or plain http only to a loopback host (local development). The host is parsed
/// rather than prefix-matched: `http://localhost.evil.com` must not pass for loopback. Every
/// service address (sign-in, sync, hosted calls) goes through this one rule.
pub fn service_url_is_allowed(url: &reqwest::Url) -> bool {
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => url.host_str().is_some_and(is_loopback_host),
        _ => false,
    }
}

pub fn normalize_webapp_url(url: &str) -> Result<Option<String>, String> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(None);
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| "Enter a valid web-app URL, including https://".to_string())?;
    if !service_url_is_allowed(&parsed) {
        return Err(
            "Use https:// for web-app sync. Plain http is allowed only for localhost.".into(),
        );
    }
    if parsed.path() != "/"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Web-app URL cannot contain credentials, a query, or a fragment.".into());
    }
    Ok(Some(parsed.to_string().trim_end_matches('/').to_string()))
}

fn get_secret(account: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|_| "The operating system credential store is unavailable. Unlock your keychain or enable a Linux Secret Service, then try again.".to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("The operating system could not read a saved credential. Unlock your keychain or enable a Linux Secret Service, then try again.".into()),
    }
}

fn set_secret(account: &str, secret: Option<&str>) -> Result<(), String> {
    // Invalidate before and after: a failed write may still have changed the store.
    PRESENCE.invalidate();
    let result = write_secret(account, secret);
    PRESENCE.invalidate();
    result
}

fn write_secret(account: &str, secret: Option<&str>) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|_| "The operating system credential store is unavailable. Unlock your keychain or enable a Linux Secret Service, then try again.".to_string())?;
    match secret.filter(|secret| !secret.is_empty()) {
        Some(secret) => entry.set_password(secret).map_err(|_| {
            "The operating system could not save this credential. Unlock your keychain or enable a Linux Secret Service, then try again.".into()
        }),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("The operating system could not remove this saved credential.".into()),
        },
    }
}

#[cfg(test)]
mod hosted_tests {
    use super::*;

    #[test]
    fn loopback_sign_in_urls_normalize_for_every_loopback_spelling() {
        for url in [
            "http://localhost:3000",
            "http://127.0.0.1:8080",
            "http://127.0.0.2:8080",
            "http://[::1]:3000",
            "https://notes.example.com/",
        ] {
            assert!(normalize_webapp_url(url).unwrap().is_some(), "{url}");
        }
        for url in [
            "http://notes.example.com",
            "http://localhost.evil.com",
            "http://[2001:db8::1]",
        ] {
            assert!(normalize_webapp_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn credential_presence_is_loaded_once_until_invalidated_and_failures_are_not_kept() {
        let cache = PresenceCache::default();
        let mut loads = 0;
        let mut load = |has_claude: bool| {
            loads += 1;
            Ok(CredentialPresence {
                claude: has_claude,
                ..Default::default()
            })
        };
        assert!(cache.get_or_load(|| load(true)).unwrap().claude);
        assert!(
            cache.get_or_load(|| load(false)).unwrap().claude,
            "second call is cached"
        );
        cache.invalidate();
        assert!(
            !cache.get_or_load(|| load(false)).unwrap().claude,
            "reloaded after a write"
        );
        assert_eq!(loads, 2);

        let failing = PresenceCache::default();
        assert!(failing.get_or_load(|| Err("locked".into())).is_err());
        assert!(failing
            .get_or_load(|| Ok(CredentialPresence::default()))
            .is_ok());
    }

    fn account(expires_at: &str) -> HostedAccount {
        HostedAccount {
            email: "a@b.co".into(),
            base_url: "https://notes.test".into(),
            account_id: "acct".into(),
            workspace_id: "ws".into(),
            plan: "pro".into(),
            expires_at: expires_at.into(),
            sync_allowed: None,
        }
    }

    #[test]
    fn settings_saved_before_hosted_sign_in_still_load() {
        let old = r#"{"transcriptionProvider":"deepgram","summarizationProvider":"claude","defaultMeetingMode":"general","customVocabulary":[],"customSummaryInstructions":"","webappUrl":""}"#;
        let loaded: DesktopPreferences = serde_json::from_str(old).unwrap();
        assert!(loaded.hosted_account.is_none());
    }

    #[test]
    fn settings_saved_with_the_removed_processing_choice_still_load() {
        let directory = tempfile::tempdir().unwrap();
        let old = r#"{"transcriptionProvider":"groq","summarizationProvider":"claude","defaultMeetingMode":"general","customVocabulary":[],"customSummaryInstructions":"","webappUrl":"","processing":"hosted"}"#;
        std::fs::write(directory.path().join(SETTINGS_FILE), old).unwrap();

        let loaded = DesktopPreferences::load(directory.path()).unwrap();

        assert_eq!(loaded.transcription_provider, TranscriptionProviderId::Groq);
    }

    #[test]
    fn a_past_expiry_ends_the_session_and_a_bad_one_does_not() {
        assert!(account("2020-01-01T00:00:00Z").is_expired());
        assert!(!account("2999-01-01T00:00:00Z").is_expired());
        assert!(!account("").is_expired());
    }

    #[test]
    fn an_expired_session_hands_out_no_connection() {
        let expired = DesktopPreferences {
            hosted_account: Some(account("2020-01-01T00:00:00Z")),
            ..DesktopPreferences::default()
        };
        assert!(hosted_session(&expired).is_none());
    }
}
