pub mod api_keys;
mod general;
pub mod shortcuts;
pub mod system;

// Re-export all commands
pub use api_keys::*;
pub use general::*;
pub use shortcuts::*;
pub use system::*;
