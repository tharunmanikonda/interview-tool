use std::fmt;

use secrecy::SecretString;

use crate::config::Provider;

/// Configuration for making transcription API calls
pub struct ApiConfig {
    pub provider: Provider,
    pub api_key: SecretString,
    /// Full transcription endpoint for Azure (without api-version), unused for OpenAI
    pub endpoint: String,
}

impl fmt::Debug for ApiConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiConfig")
            .field("provider", &self.provider)
            .field("api_key", &"[REDACTED]")
            .field("endpoint", &self.endpoint)
            .finish()
    }
}
