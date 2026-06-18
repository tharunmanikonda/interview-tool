# Migrate API Keys from String to SecretString

## Goal
Replace plain `String` with `SecretString` (from the `secrecy` crate) for all API key handling in the Rust backend. This ensures keys are zeroized on drop and redacted in debug output.

## Design Constraint
`OpenAIConfig` and `AzureOpenAIConfig` are **frontend boundary types** — they derive `Serialize`, `Deserialize`, and `specta::Type` for TypeScript binding generation. `SecretString` intentionally does NOT implement `Serialize` or `specta::Type`, so these structs must keep `String` fields. Instead, we protect the **runtime layer** (where keys live in memory longest) and add custom `Debug` to the boundary types.

## Changes

### 1. Add `secrecy` dependency
**File:** `src-tauri/Cargo.toml`
- Add `secrecy = { version = "0.10", features = ["serde"] }`

### 2. Protect runtime types with `SecretString`

**File:** `src-tauri/src/clients/config.rs` — `ApiConfig`
- Change `api_key: String` → `api_key: SecretString`
- Remove `#[derive(Debug)]`, implement custom `Debug` that prints `[REDACTED]`
- Remove `Clone` derive (SecretString doesn't implement Clone) — `ApiConfig` is only passed by reference anyway

**File:** `src-tauri/src/clients/openai_client.rs` — `OpenAIClient`
- Change `api_key: String` → `api_key: SecretString`
- Update `new()` to accept `SecretString`
- Update `add_auth()` to use `self.api_key.expose_secret()`

**File:** `src-tauri/src/clients/azure_client.rs` — `AzureClient`
- Change `api_key: String` → `api_key: SecretString`
- Update `new()` to accept `SecretString`
- Update `add_auth()` to use `self.api_key.expose_secret()`

### 3. Add custom Debug to boundary config types (redact api_key)

**File:** `src-tauri/src/config.rs` — `OpenAIConfig` and `AzureOpenAIConfig`
- Remove `Debug` from derive macros
- Implement custom `Debug` that shows `api_key: [REDACTED]`

### 4. Update conversion points (String → SecretString at boundaries)

**File:** `src-tauri/src/commands/preferences/api_keys/provider_openai.rs`
- `test_openai_config()`: wrap `api_key` with `SecretString::from(api_key)` when building `ApiConfig`

**File:** `src-tauri/src/commands/preferences/api_keys/provider_azure_openai.rs`
- `test_azure_openai_config()`: same wrapping

**File:** `src-tauri/src/clients/transcriber.rs`
- `create_api_client()`: wrap `config.api_key` with `SecretString::from()` when passing to client constructors
- `create_client_from_explicit_config()`: use `config.api_key.expose_secret()` where needed — actually, `api_key` is already `SecretString` in `ApiConfig`, so just clone/pass the secret

### 5. Summary of file changes

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `secrecy` dependency |
| `src-tauri/src/clients/config.rs` | `api_key` → `SecretString`, custom Debug |
| `src-tauri/src/clients/openai_client.rs` | `api_key` → `SecretString`, expose at auth point |
| `src-tauri/src/clients/azure_client.rs` | `api_key` → `SecretString`, expose at auth point |
| `src-tauri/src/config.rs` | Custom Debug for `OpenAIConfig`, `AzureOpenAIConfig` |
| `src-tauri/src/commands/.../provider_openai.rs` | Wrap String → SecretString |
| `src-tauri/src/commands/.../provider_azure_openai.rs` | Wrap String → SecretString |
| `src-tauri/src/clients/transcriber.rs` | Wrap String → SecretString at keychain boundary |

### 6. Frontend impact
**None.** The TypeScript types stay the same — `apiKey: string`. The `SecretString` protection is entirely backend-side.

## Verification
1. `npm run verify` — must pass with no errors/warnings
2. Manual test: configure an OpenAI key, run a transcription, verify it works
3. Verify Debug output: add a temporary `dbg!()` on any config struct and confirm api_key shows `[REDACTED]`
