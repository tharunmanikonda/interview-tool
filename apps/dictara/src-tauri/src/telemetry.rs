use crate::config::{Config, ConfigKey, ConfigStore, TelemetryConfig};
use log::{error, info, warn};
use std::panic;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::Duration;
use uuid::Uuid;

/// Enable Sentry telemetry in debug builds for local testing
///
/// Set this to `true` to test Sentry integration while running `npm run dev:tauri`
/// WARNING: Your dev sessions will be sent to Sentry and count toward DAU!
///
/// Usage:
/// - `false` (default): Debug builds skip Sentry, only production sends metrics
/// - `true`: Debug builds send to Sentry (useful for testing integration)
#[allow(dead_code)]
const ENABLE_SENTRY_IN_DEBUG: bool = true;

/// Get or create a unique device ID for telemetry
///
/// If a device ID already exists in the config, it will be returned.
/// Otherwise, a new UUID v4 will be generated and stored.
pub fn get_or_create_device_id(config: &Config) -> String {
    // Try to get existing device ID
    if let Some(telemetry) = config.get(&ConfigKey::TELEMETRY) {
        info!("Using existing device ID for telemetry");
        return telemetry.device_id;
    }

    // Generate new UUID if none exists
    let device_id = Uuid::new_v4().to_string();
    info!("Generated new device ID for telemetry: {}", device_id);

    // Store it
    let telemetry_config = TelemetryConfig {
        device_id: device_id.clone(),
        telemetry_enabled: true, // Enable by default
        last_session_start: None,
    };

    if let Err(e) = config.set(&ConfigKey::TELEMETRY, telemetry_config) {
        warn!("Failed to save telemetry config: {}", e);
    }

    device_id
}

/// Initialize Sentry for error tracking and telemetry
///
/// Reads SENTRY_DSN from environment variables.
/// If not set, or in debug builds (unless ENABLE_SENTRY_IN_DEBUG=true), Sentry will be disabled.
pub fn init_sentry(device_id: &str, config: &Config) -> Option<sentry::ClientInitGuard> {
    // Disable Sentry in debug builds unless explicitly enabled for testing
    #[cfg(debug_assertions)]
    {
        if !ENABLE_SENTRY_IN_DEBUG {
            let _ = (device_id, config); // Suppress unused variable warnings
            info!("Sentry disabled in debug build (set ENABLE_SENTRY_IN_DEBUG=true to test)");
            return None;
        }
        info!("⚠️  Sentry ENABLED in debug build for testing (your dev sessions will count toward DAU!)");
    }

    // Get DSN from compile-time environment variable (baked into binary at build time)
    // For local dev: .env is loaded before compilation via build script
    // For production: .env is loaded before tauri build via package.json script
    const DSN: Option<&str> = option_env!("SENTRY_DSN");

    let dsn = match DSN {
        Some(dsn) if !dsn.is_empty() => dsn.to_string(),
        _ => {
            info!("Sentry DSN not configured, telemetry disabled");
            return None;
        }
    };

    let release_name = sentry::release_name!();
    info!("Initializing Sentry with device ID: {}", device_id);
    info!(
        "Sentry release name: {}",
        release_name
            .as_ref()
            .map(|s| s.as_ref())
            .unwrap_or("unknown")
    );

    // Parse DSN manually to validate it and avoid potential panic
    // sentry::init() can panic on malformed DSNs, so we validate first
    let parsed_dsn = match dsn.parse::<sentry::types::Dsn>() {
        Ok(dsn) => dsn,
        Err(e) => {
            warn!("Invalid Sentry DSN format: {}. Telemetry disabled.", e);
            return None;
        }
    };

    // Wrap entire Sentry initialization in panic catch
    // According to Sentry docs: "This will panic when the provided DSN is invalid"
    // Even though we parse the DSN manually, there could be other edge cases that panic
    let result = panic::catch_unwind(|| {
        // Initialize Sentry with validated DSN
        // Note: auto_session_tracking is DISABLED to allow setting user context first
        // We manually start the session after setting user ID to ensure proper user tracking
        let guard = sentry::init(sentry::ClientOptions {
            dsn: Some(parsed_dsn),
            release: release_name,
            // Set environment: "development" for debug builds, "production" for release builds
            // Required for release health tracking and session data to appear in Releases page
            environment: Some(if cfg!(debug_assertions) {
                "development".into()
            } else {
                "production".into()
            }),
            // Disable automatic session tracking (we'll start manually after setting user)
            auto_session_tracking: false,
            // Set session mode to Application for desktop app (not Request mode for servers)
            session_mode: sentry::SessionMode::Application,
            // Sample rate: 100% of errors (adjust in production if needed)
            sample_rate: 1.0,
            ..Default::default()
        });

        // Set user context with device ID BEFORE starting session
        // This ensures sessions are properly attributed to users
        sentry::configure_scope(|scope| {
            scope.set_user(Some(sentry::User {
                id: Some(device_id.to_string()),
                ..Default::default()
            }));
        });

        // Manually start session after user context is set
        sentry::start_session();

        guard
    });

    match result {
        Ok(guard) => {
            // Update session start time and handle midnight refresh
            refresh_session_if_needed(config);

            // Spawn background task to periodically check for midnight boundary crossing
            // This ensures accurate DAU tracking for long-running sessions
            start_session_refresh_task(config.clone());

            info!("Sentry initialized successfully");
            Some(guard)
        }
        Err(panic_info) => {
            // Panic occurred during Sentry initialization
            // Log error and gracefully degrade to no telemetry
            error!(
                "Sentry initialization panicked: {:?}. Telemetry disabled.",
                panic_info
            );
            None
        }
    }
}

/// Refresh Sentry session if we've crossed midnight boundary
///
/// For long-running background apps, we need to manually refresh sessions
/// at midnight to get accurate Daily Active User (DAU) metrics.
///
/// This should be called:
/// - On app startup (in case of Mac reboot)
/// - Periodically (optional, for apps that run for days)
pub fn refresh_session_if_needed(config: &Config) {
    // Skip if in debug mode and testing is not enabled
    #[cfg(debug_assertions)]
    {
        if !ENABLE_SENTRY_IN_DEBUG {
            return;
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Get last session start time
    let mut telemetry = config.get(&ConfigKey::TELEMETRY);

    let should_refresh = match &telemetry {
        Some(cfg) => {
            if let Some(last_start) = cfg.last_session_start {
                // Check if we've crossed midnight boundary
                let last_day = last_start / 86400; // Days since epoch
                let current_day = now / 86400;

                current_day > last_day
            } else {
                // No previous session start time, this is first session
                // Don't refresh, just record the timestamp (auto_session_tracking already started a session)
                false
            }
        }
        None => {
            // No telemetry config yet, shouldn't happen but handle gracefully
            warn!("Telemetry config not found when refreshing session");
            return;
        }
    };

    if should_refresh {
        info!("Refreshing Sentry session (crossed midnight boundary)");

        // End current session and start new one
        sentry::end_session();
        sentry::start_session();
    }

    // Always update last session start time (whether refreshed or first run)
    if let Some(ref mut cfg) = telemetry {
        cfg.last_session_start = Some(now);
        if let Err(e) = config.set(&ConfigKey::TELEMETRY, cfg.clone()) {
            warn!("Failed to update session start time: {}", e);
        }
    }
}

/// Start background task to periodically refresh sessions at midnight
///
/// For long-running desktop apps, we need to manually refresh sessions
/// when crossing the midnight boundary to get accurate DAU metrics.
///
/// This spawns a background task using tauri::async_runtime that checks every hour
/// if we've crossed midnight, and refreshes the session if needed.
fn start_session_refresh_task(config: Config) {
    tauri::async_runtime::spawn(async move {
        // Check every hour if we've crossed midnight
        let mut interval = tokio::time::interval(Duration::from_secs(3600)); // 1 hour

        loop {
            interval.tick().await;

            // Skip if in debug mode and testing is not enabled
            #[cfg(debug_assertions)]
            {
                if !ENABLE_SENTRY_IN_DEBUG {
                    continue;
                }
            }

            info!("Running periodic session refresh check");
            refresh_session_if_needed(&config);
        }
    });

    info!("Started periodic session refresh task (checks every hour)");
}
