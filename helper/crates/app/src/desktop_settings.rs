//! Desktop-owned preferences. Secrets live in the platform credential store;
//! this JSON file contains only provider choices and non-secret preferences.

use notetaker_core::native_messaging::{
    ApiKeys, MeetingMode, SummarizationProviderId, TranscriptionProviderId, WebappConfig,
};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::Path;

const SERVICE: &str = "com.ainotetaker.desktop";
const SETTINGS_FILE: &str = "desktop-settings.json";

pub const DEFAULT_WEBAPP_URL: &str = "https://ai-notetaker.apercallc.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub transcription_provider: TranscriptionProviderId,
    pub summarization_provider: SummarizationProviderId,
    pub default_meeting_mode: MeetingMode,
    pub custom_vocabulary: Vec<String>,
    pub custom_summary_instructions: String,
    pub webapp_url: String,
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
}

impl DesktopPreferences {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join(SETTINGS_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
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

pub fn settings_view(
    preferences: DesktopPreferences,
    keys: &ApiKeys,
    has_webapp_token: bool,
) -> DesktopSettingsView {
    DesktopSettingsView {
        preferences,
        has_deepgram_key: keys.deepgram.is_some(),
        has_groq_key: keys.groq.is_some(),
        has_claude_key: keys.claude.is_some(),
        has_gemini_key: keys.gemini.is_some(),
        has_deepseek_key: keys.deepseek.is_some(),
        has_webapp_token,
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

pub fn normalize_webapp_url(url: &str) -> Result<Option<String>, String> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(None);
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| "Enter a valid web-app URL, including https://".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
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
