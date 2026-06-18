# Summary

Dictara is a macOS desktop application built with Tauri (Rust backend + React/TypeScript frontend) that provides speech-to-text transcription functionality. The app captures audio via microphone when the user presses the Fn/Globe key, sends it to OpenAI or Azure OpenAI Whisper API for transcription, and automatically pastes the result into the active application. The application requires macOS Accessibility permissions for global keyboard monitoring and stores API credentials securely in the macOS Keychain.

# Security Risks/Issues

No issues observed.

# Positive Security Practices Observed

1. **Secure Credential Storage**: API keys stored in macOS Keychain via `keyring` crate, not in plain text files

2. **No Hardcoded Secrets**: No API keys or credentials committed to source code

3. **HTTPS Only**: All external API calls (OpenAI, Azure OpenAI) use HTTPS exclusively

4. **No XSS Vulnerabilities**: React frontend has zero instances of dangerous HTML injection methods or dynamic code execution patterns

5. **Type-Safe IPC**: Uses `tauri-specta` for type-safe command invocations between frontend and backend

6. **Secure Updates**: Application updates verified with cryptographic signatures (minisign)

7. **Proper Cleanup**: Audio recording files deleted after successful transcription

8. **No Sensitive Data Logging**: API keys not logged anywhere in the codebase

9. **Input Validation**: Frontend validates API key length (min 20 chars) and Azure endpoint format (HTTPS required)

10. **Memory Safety**: Rust backend eliminates entire classes of memory safety vulnerabilities

11. **Explicit Permissions**: App explicitly requests microphone and accessibility permissions from the user

12. **API Key Validation**: Credentials are tested against actual APIs before being saved
