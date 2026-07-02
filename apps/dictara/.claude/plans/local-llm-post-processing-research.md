# Local LLM for Transcription Post-Processing - Research & Design

## Executive Summary

**Good news**: Local LLMs are **excellent** for transcription post-processing tasks like formatting, punctuation correction, and bullet point generation. The Handy project already implements this feature with Ollama support, which we can learn from and adapt.

**User Preferences** (from discussion):
- Priority: Remote APIs (OpenAI, etc.) first, local as fallback
- Feature-toggle UI: Users select formatting options (bullet points, etc.) rather than editing raw prompts
- Default: Disabled by default

---

## Local LLM Integration Options

### Option A: Embedded (Recommended for Dictara)
**Like whisper-rs for Whisper** - no external installation needed.

| Crate | Description | Status |
|-------|-------------|--------|
| [llama-cpp-2](https://crates.io/crates/llama-cpp-2) | Bindgen to llama.cpp, instant feature parity | Active, recommended |
| [llama_cpp](https://github.com/edgenai/llama_cpp-rs) | High-level async bindings | Active, easy to use |

**Pros:**
- No Ollama installation required
- Works exactly like whisper-rs
- Single binary distribution
- GPU acceleration via Metal/CUDA/Vulkan

**Cons:**
- Larger app size (model bundled or downloaded)
- Build requires clang
- More complex model management

### Option B: Service-based (Ollama)
Call Ollama's OpenAI-compatible API.

**Pros:**
- Easy API integration
- Model hot-swapping
- Ollama handles GPU optimization

**Cons:**
- Users must install Ollama separately
- External dependency

### Recommendation
**Hybrid approach** matching Dictara's transcription pattern:
1. **Remote first**: OpenAI/Anthropic/Groq APIs (priority)
2. **Local embedded**: llama-cpp-2 for users who want full offline (like local Whisper)
3. **Local service**: Optional Ollama support for advanced users

---

## Research Findings

### 1. Handy Project Analysis

**Handy already has LLM post-processing built-in!** Key implementation details:

| Component | File | Description |
|-----------|------|-------------|
| LLM Client | [llm_client.rs](ai-context/Handy/src-tauri/src/llm_client.rs) | OpenAI-compatible API client |
| Post-processing logic | [actions.rs:29-163](ai-context/Handy/src-tauri/src/actions.rs#L29-L163) | `maybe_post_process_transcription()` function |
| Settings | [settings.rs:371-451](ai-context/Handy/src-tauri/src/settings.rs#L371-L451) | Provider configs including Ollama |

**Handy's supported providers:**
- OpenAI
- OpenRouter
- Anthropic
- Groq
- Cerebras
- **Custom (defaults to `http://localhost:11434/v1` - Ollama!)**
- Apple Intelligence (macOS only)

**Handy's default prompt:**
```
Clean this transcript:
1. Fix spelling, capitalization, and punctuation errors
2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5)
3. Replace spoken punctuation with symbols (period → ., comma → ,)
4. Remove filler words (um, uh, like as filler)
5. Keep the language in the original version

Preserve exact meaning and word order. Do not paraphrase or reorder content.
Return only the cleaned transcript.

Transcript:
${output}
```

### 2. Complete Model Catalog for Post-Processing

#### Specialized Text Correction Models (Smallest)

| Model | Provider | Params | File Size (Q4) | Memory | Best For | License |
|-------|----------|--------|----------------|--------|----------|---------|
| **T5-small-grammar** | Google/Vennify | 60M | ~120 MB | ~200 MB | Punctuation & grammar only | Apache 2.0 |
| **ByT5-text-correction** | Google | 220M | ~400 MB | ~500 MB | Punctuation + capitalization | Apache 2.0 |

⚠️ **Limitation**: These only do grammar/punctuation. Cannot do bullet points, email formatting, or complex restructuring.

#### Ultra-Small General LLMs (0.5B - 2B)

| Model | Provider | Params | File Size (Q4) | Memory | Best For | License |
|-------|----------|--------|----------------|--------|----------|---------|
| **Qwen 2.5 0.5B** | Alibaba | 0.5B | ~400 MB | ~0.5 GB | Basic formatting, multilingual (29 langs) | Apache 2.0 |
| **Qwen3 0.6B** | Alibaba | 0.6B | ~500 MB | ~0.6 GB | Better instruction following than 0.5B | Apache 2.0 |
| **Llama 3.2 1B** | Meta | 1B | ~700 MB | ~1 GB | General-purpose tiny model | Llama License |
| **SmolLM2 1.7B** | Hugging Face | 1.7B | ~1.2 GB | ~1.5 GB | Beats Qwen 1.5B & Llama 1B in benchmarks | Apache 2.0 |
| **Gemma 2 2B** | Google | 2B | ~1.5 GB | ~2 GB | Best quality in tiny category | Gemma License |

✅ **Good for**: Simple formatting (punctuation, filler removal, number conversion)
⚠️ **Limitation**: Struggle with long text or multiple errors per sentence

#### Small General LLMs (3B - 4B) - Recommended Balance

| Model | Provider | Params | File Size (Q4) | Memory | Best For | License |
|-------|----------|--------|----------------|--------|----------|---------|
| **Llama 3.2 3B** | Meta | 3B | ~2 GB | ~3-4 GB | Fast, good instruction following | Llama License |
| **Phi-3 Mini** | Microsoft | 3.8B | ~2.5 GB | ~4 GB | Rivals 7B quality, great for formatting | MIT ✨ |
| **Qwen 2.5 3B** | Alibaba | 3B | ~2 GB | ~3-4 GB | Multilingual, structured output | Apache 2.0 |
| **SmolLM3 3B** | Hugging Face | 3B | ~2 GB | ~3-4 GB | Outperforms Llama 3.2 3B & Qwen 2.5 3B | Apache 2.0 |

✅ **Recommended tier**: Best balance of quality, speed, and memory for text formatting

#### Medium General LLMs (7B - 9B) - Best Quality

| Model | Provider | Params | File Size (Q4) | Memory | Best For | License |
|-------|----------|--------|----------------|--------|----------|---------|
| **Mistral 7B** | Mistral AI | 7B | ~4 GB | ~5-6 GB | General purpose, fast | Apache 2.0 |
| **Qwen 2.5 7B** | Alibaba | 7B | ~4 GB | ~5-6 GB | Best multilingual, JSON/table formatting | Apache 2.0 |
| **Llama 3.1 8B** | Meta | 8B | ~5 GB | ~6-7 GB | General purpose, well-tested | Llama License |
| **Gemma 2 9B** | Google | 9B | ~5.5 GB | ~7-8 GB | Best quality/size ratio in category | Gemma License |

✅ **Best quality** for complex formatting (bullet points, email structure, summaries)
⚠️ **Requires**: 16GB+ RAM recommended

#### Quick Reference: Memory by Use Case

| Use Case | Minimum Model | Memory Needed |
|----------|---------------|---------------|
| Punctuation only | T5-small (60M) | ~200 MB |
| Basic formatting | Qwen 0.5B | ~0.5 GB |
| Good formatting | Phi-3 Mini (3.8B) | ~4 GB |
| Best quality | Gemma 2 9B | ~7-8 GB |

**Key insight**: For simple text formatting (punctuation, filler removal), even 0.5B-1B models work well. For bullet points and email formatting, use 3B+ models.

#### Dictara Default Model Recommendation

| Priority | Model | Why |
|----------|-------|-----|
| **1st choice** | Phi-3 Mini (3.8B) | MIT license, Microsoft backing, rivals 7B quality, ~4GB memory |
| **2nd choice** | SmolLM2 1.7B | Apache 2.0, only ~1.5GB, beats larger models in benchmarks |
| **Budget option** | Qwen 2.5 0.5B | Apache 2.0, only ~0.5GB, good for basic punctuation |

**Suggested UX flow:**
1. Detect available RAM
2. Recommend appropriate model tier:
   - <8GB RAM → Offer Qwen 0.5B or SmolLM2 1.7B
   - 8-16GB RAM → Recommend Phi-3 Mini (3.8B)
   - >16GB RAM → Offer Gemma 2 9B for best quality

### 3. Quality Assessment

According to benchmarks:
- **96%+ accuracy retention** with Q4 quantization for formatting tasks
- **97.1% quality retention** with Q4_K_M compression
- Small models (3B-7B) are particularly strong for:
  - Punctuation insertion
  - Capitalization correction
  - Filler word removal
  - Number formatting (spoken → digits)

### 4. Integration Options

#### Option A: Ollama (Recommended)
- **Pros**: Simple setup, OpenAI-compatible API, model management, GPU acceleration
- **Cons**: Requires separate installation (~50MB base)
- **API endpoint**: `http://localhost:11434/v1/chat/completions`

#### Option B: llama.cpp Direct
- **Pros**: No external dependencies, single binary
- **Cons**: More complex integration, less model management

#### Option C: LM Studio
- **Pros**: Great UI for model management
- **Cons**: Heavier, not headless-friendly

---

## Proposed Architecture for Dictara

### High-Level Flow

```
Audio → Whisper Transcription → LLM Post-Processing → Formatted Text
                                       ↓
                            [Ollama / OpenAI / Cloud API]
```

### Components to Add

1. **LLM Client Module** (`src-tauri/src/llm/mod.rs`)
   - OpenAI-compatible API client
   - Support for local (Ollama) and remote providers
   - Async request handling

2. **Post-Processing Service** (`src-tauri/src/llm/post_processor.rs`)
   - Prompt management
   - Provider selection
   - Fallback handling (if LLM unavailable, return original text)

3. **Settings Extensions**
   - Post-processing toggle (enabled/disabled)
   - Provider selection (Ollama, OpenAI, etc.)
   - Model selection per provider
   - Custom prompt editing

4. **Frontend Components**
   - Post-processing settings panel
   - Prompt editor
   - Model selector
   - Ollama connection status indicator

### Settings Schema

```rust
pub struct PostProcessSettings {
    pub enabled: bool,
    pub provider_id: String,  // "ollama", "openai", etc.
    pub providers: Vec<PostProcessProvider>,
    pub api_keys: HashMap<String, String>,
    pub models: HashMap<String, String>,
    pub prompts: Vec<LLMPrompt>,
    pub selected_prompt_id: Option<String>,
}

pub struct PostProcessProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
}
```

### Default Providers

```rust
vec![
    PostProcessProvider {
        id: "ollama".to_string(),
        label: "Ollama (Local)".to_string(),
        base_url: "http://localhost:11434/v1".to_string(),
    },
    PostProcessProvider {
        id: "openai".to_string(),
        label: "OpenAI".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
    },
    // ... more providers
]
```

---

## Feature-Toggle UI Design

Instead of raw prompt editing, users toggle formatting features that dynamically build the system prompt.

### User Interface

```
┌─────────────────────────────────────────────────────┐
│ Post-Processing Settings                             │
├─────────────────────────────────────────────────────┤
│ ☑ Enable post-processing                            │
│                                                      │
│ Provider: [OpenAI ▾]                                │
│ Model:    [gpt-4o-mini ▾]                           │
│                                                      │
│ ─── Formatting Options ────                         │
│ ☑ Fix punctuation & capitalization                  │
│ ☑ Convert spoken numbers to digits (five → 5)       │
│ ☑ Remove filler words (um, uh, like)               │
│ ☐ Create bullet points                              │
│ ☐ Create paragraph breaks                           │
│ ☐ Format as email                                   │
│                                                      │
│ ─── Advanced ────                                   │
│ ☐ Custom prompt override                            │
│   [────────────────────────────────]               │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### Dynamic Prompt Building

```rust
pub struct PostProcessOptions {
    pub fix_punctuation: bool,      // default: true
    pub convert_numbers: bool,       // default: true
    pub remove_fillers: bool,        // default: true
    pub create_bullets: bool,        // default: false
    pub paragraph_breaks: bool,      // default: false
    pub email_format: bool,          // default: false
    pub custom_prompt: Option<String>,
}

impl PostProcessOptions {
    pub fn build_prompt(&self, transcript: &str) -> String {
        if let Some(custom) = &self.custom_prompt {
            return custom.replace("${output}", transcript);
        }

        let mut instructions = vec!["Process this transcript:"];

        if self.fix_punctuation {
            instructions.push("- Fix punctuation, spelling, and capitalization");
        }
        if self.convert_numbers {
            instructions.push("- Convert spoken numbers to digits (e.g., 'five' → '5')");
        }
        if self.remove_fillers {
            instructions.push("- Remove filler words (um, uh, like as filler)");
        }
        if self.create_bullets {
            instructions.push("- Format as bullet points");
        }
        if self.paragraph_breaks {
            instructions.push("- Add logical paragraph breaks");
        }
        if self.email_format {
            instructions.push("- Format as a professional email");
        }

        instructions.push("\nPreserve original meaning. Keep the same language.");
        instructions.push("Return only the processed text.\n");
        instructions.push(&format!("Transcript:\n{}", transcript));

        instructions.join("\n")
    }
}
```

---

## Implementation Plan

### Phase 1: Remote API Support (Priority)
**Files to create:**
- `src-tauri/src/llm/mod.rs` - Module definition
- `src-tauri/src/llm/client.rs` - OpenAI-compatible HTTP client
- `src-tauri/src/llm/post_processor.rs` - Post-processing logic
- `src-tauri/src/llm/options.rs` - Feature toggle options & prompt builder

**Tasks:**
1. Create OpenAI-compatible API client (works with OpenAI, Groq, OpenRouter, Anthropic)
2. Add post-processing settings to config
3. Implement `PostProcessOptions` struct with dynamic prompt building
4. Integrate with transcription pipeline (call post-processor after transcription)

### Phase 2: Frontend Settings UI
**Files to modify:**
- `src/components/settings/` - Add new settings section
- `src/hooks/` - Add TanStack Query hooks for provider/model fetching

**Tasks:**
1. Create post-processing settings panel with feature toggles
2. Add provider dropdown (OpenAI, Groq, OpenRouter, Local, etc.)
3. Add model selector with dynamic loading from provider
4. Add API key input field (stored securely)
5. Add "Test Connection" button

### Phase 3: Local LLM Support (Optional)
**Options:**
- **Option A**: Add llama-cpp-2 for embedded inference (like whisper-rs)
- **Option B**: Add Ollama API support (user installs Ollama separately)
- **Option C**: Both - let users choose

**Tasks:**
1. Add llama-cpp-2 dependency (if going embedded route)
2. Create model downloader for GGUF files
3. Add model management UI
4. Implement GPU acceleration detection

### Phase 4: Polish & Edge Cases
1. Graceful fallback: return original text if LLM fails
2. Timeout handling: don't block UI on slow responses
3. Loading indicator during post-processing
4. Error messages for API key issues
5. Latency metrics in debug mode

---

## Technical Considerations

### Latency
- Local models (3B): ~0.5-1s for typical transcriptions
- Local models (7B): ~1-2s for typical transcriptions
- Cloud APIs: Variable (network-dependent)

### Memory Usage
- Ollama with 7B model: ~4-6GB VRAM or ~8GB RAM (CPU mode)
- Ollama with 3B model: ~2-3GB VRAM or ~4GB RAM (CPU mode)

### Fallback Strategy
If LLM post-processing fails:
1. Log the error
2. Return original transcription
3. Optionally notify user

---

## Verification & Testing

### How to Test
1. **Unit tests**: Test prompt building with different option combinations
2. **Integration test**: Mock OpenAI API, verify request format
3. **E2E test**:
   - Enable post-processing with OpenAI
   - Record audio → transcribe → verify formatted output
4. **Error handling**: Test with invalid API key, network timeout

### Expected Behavior
- With post-processing enabled: transcribed text is formatted per selected options
- With post-processing disabled: transcribed text is raw from Whisper
- If LLM fails: return original transcription (graceful degradation)

---

## Sources

- [OpenAI Cookbook: Whisper Processing Guide](https://cookbook.openai.com/examples/whisper_processing_guide)
- [Meetily: Local Meeting Notes with Whisper + Ollama](https://dev.to/zackriya/local-meeting-notes-with-whisper-transcription-ollama-summaries-gemma3n-llama-mistral--2i3n)
- [Best Ollama Models 2025](https://collabnix.com/best-ollama-models-in-2025-complete-performance-comparison/)
- [Whisper-AI-transcription-LMStudio-formatting](https://github.com/Andi-wink/Whisper-AI-transcription-LMStudio-formatting)
- [Local LLM Hosting Guide 2025](https://www.glukhov.org/post/2025/11/hosting-llms-ollama-localai-jan-lmstudio-vllm-comparison/)
- [Top Small Language Models](https://www.bentoml.com/blog/the-best-open-source-small-language-models)
