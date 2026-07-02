# Research: Streaming Audio Transcription for Dictara

**Status:** Research Complete
**Decision:** VAD-based chunking recommended (works with all backends, cost-neutral)

## Executive Summary

This document explores options for streaming audio transcription instead of the current batch approach where 10-minute audio files (~25MB) are sent after recording completes.

**TL;DR:** Use your existing Silero VAD to detect silence boundaries → transcribe chunks progressively → works with OpenAI, Azure, and Local Whisper with no extra cost.

---

## Current Dictara Architecture

**Recording Pipeline** ([audio_recorder.rs](src-tauri/src/recording/audio_recorder.rs)):
- Audio captured via `cpal` → resampled to 16kHz mono
- Silero VAD V6 filters speech vs silence in real-time
- Only speech frames written to WAV file
- After recording stops → entire file sent to transcription backend

**VAD Configuration** ([vad.rs](src-tauri/src/recording/vad.rs)):
- Frame size: 512 samples at 16kHz = **32ms per frame**
- Prefill buffer: 14 frames (448ms) - captures audio before speech onset
- Hangover: 14 frames (448ms) - keeps silence after speech ends
- Threshold: 0.5 probability

**Supported Backends** ([transcriber.rs](src-tauri/src/clients/transcriber.rs)):
1. OpenAI Whisper API (`whisper-1`)
2. Azure OpenAI
3. Local Whisper (whisper-rs with GGML models)

---

## Research Findings

### 1. OpenAI Realtime Transcription API (NEW!)

OpenAI now offers an official [Realtime Transcription API](https://platform.openai.com/docs/guides/realtime-transcription) with true streaming support.

**Features:**
- WebSocket-based streaming (WebRTC also supported)
- Models: `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`
- Built-in VAD options:
  - `server_vad`: configurable threshold, silence_duration_ms, prefix_padding_ms
  - `semantic_vad`: AI-powered turn detection with "eagerness" parameter
- Events: `conversation.item.input_audio_transcription.delta` and `.completed`

**Pricing:**
| API Type | Cost |
|----------|------|
| Realtime API (audio input) | ~$0.06/min |
| Standard Transcription (whisper-1) | $0.006/min |
| GPT-4o Transcribe | $0.006/min |
| GPT-4o Mini Transcribe | $0.003/min |

**Pros:**
- Official support, low latency
- Built-in VAD eliminates need for local VAD
- True streaming with partial results

**Cons:**
- 10x higher cost for Realtime API vs batch
- Requires WebSocket connection
- Silence still counts if streaming continuously

### 2. Azure OpenAI Realtime API

[Azure Realtime Audio API](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/realtime-audio) offers similar capabilities.

**Features:**
- Connection via WebSocket, WebRTC, or SIP
- Models: `gpt-4o-realtime-preview`, `gpt-4o-mini-realtime-preview`
- Whisper transcription via `input_audio_transcription` property
- API version: `2025-08-28` (GA)

**Limitations:**
- Batch Whisper: 25MB file limit
- For files >25MB: Use Azure Speech Batch Transcription (up to 1GB)

### 3. Local Streaming Solutions

#### whisper-flow (already cloned to ai-context/)

**Tumbling Window Technique** ([streaming.py](ai-context/whisper-flow/whisperflow/streaming.py)):
```
1. Accumulate audio chunks in a window
2. Transcribe the window repeatedly as chunks arrive
3. When same text appears twice → segment is "closed" (stable)
4. Reset window, start new segment
5. Return partial results until final
```

**Performance (MacBook Air M1):**
- Average latency: 275ms (range: 155-471ms)
- Word Error Rate: ~7%

**Key insight:** It doesn't modify Whisper - it wraps it with intelligent windowing.

**Pros:**
- No API costs, privacy preserved
- Sub-500ms latency
- Works with existing Whisper models

**Cons:**
- Python-based (Dictara is Rust)
- CPU/GPU intensive (transcribes same audio multiple times)
- Only works with local Whisper

#### Other Solutions

| Project | Description |
|---------|-------------|
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 4x faster using CTranslate2, supports streaming |
| [WhisperLive](https://github.com/collabora/WhisperLive) | Real-time transcription server |
| [whisper_streaming](https://github.com/ufal/whisper_streaming) → SimulStreaming | Being replaced by faster alternative |

### 4. VAD-Based Chunking Approach

**Concept:** Use your existing Silero VAD to detect silence boundaries and transcribe chunks incrementally.

From [Silero VAD research](https://github.com/snakers4/silero-vad):
- Process 30ms chunks in ~1ms
- Standard threshold: 0.5
- Already integrated in faster-whisper (removes silence >2 seconds)

**How it would work for Dictara:**
```
┌─────────────────────────────────────────────────────────┐
│ Audio Stream → Silero VAD → Silence Detection           │
│                     ↓                                   │
│           [Speech segment ends]                         │
│                     ↓                                   │
│     Transcribe chunk → Append to full transcript        │
│                     ↓                                   │
│        Continue recording next segment                  │
└─────────────────────────────────────────────────────────┘
```

**Pros:**
- Already have Silero VAD running
- Works with all backends (OpenAI, Azure, Local)
- Progressive results as you speak
- Natural chunking at sentence/phrase boundaries

**Cons:**
- Not true real-time (waits for silence)
- Multiple API calls (but same total audio volume = same cost)
- Need to handle chunk stitching for context

---

## Streaming Options Summary

| Approach | Latency | Works With | Cost Impact | Complexity |
|----------|---------|------------|-------------|------------|
| **OpenAI Realtime API** | <1s | OpenAI only | 10x higher | Medium (WebSocket) |
| **Tumbling Window** (whisper-flow style) | 275ms | Local only | None | High (port to Rust) |
| **VAD-based Chunking** | Silence-dependent (~1-3s) | All backends | Same | Low-Medium |
| **Batch (current)** | End of recording | All backends | Baseline | Already done |

---

## Recommendation: VAD-Based Chunking

Given Dictara's architecture, the most pragmatic approach:

### Why This Approach?
1. **Already have Silero VAD** running during recording
2. **Works with all backends** - OpenAI, Azure, and Local
3. **Natural speech boundaries** - silence = end of sentence/thought
4. **No architecture overhaul** - incremental enhancement
5. **Cost neutral** - same total audio, same cost

### High-Level Implementation Idea

1. **Extend VAD to emit "segment closed" events** when silence duration exceeds threshold (e.g., 800ms-1.5s)
2. **Create temporary WAV chunks** for each speech segment
3. **Stream chunks to transcription backend** while recording continues
4. **Emit progressive transcription events** to frontend
5. **Concatenate results** for final transcript

### Alternative: OpenAI Realtime API

If true real-time is required (transcription while speaking, not just at pauses):
- Implement WebSocket connection to OpenAI Realtime API
- Higher cost but official support
- Could use their VAD instead of Silero

---

## Revised Goal: Reduce Post-Recording Latency

The actual goal is to **reduce the wait time after recording stops**, not real-time feedback during recording.

**Current problem:** Record 5 min → Stop → Wait 10+ seconds for transcription (especially local models)

---

## New Research: Latency Reduction Approaches

### Approach 1: Parallel Chunk Transcription (Local Whisper)

**How it works:**
1. Split audio into N chunks at silence boundaries (using your existing VAD)
2. Create multiple `WhisperState` instances from the same `WhisperContext`
3. Transcribe chunks in parallel on different threads
4. Stitch results together

**Key insight from whisper.cpp architecture:**
- `WhisperContext` = model weights (expensive to load once)
- `WhisperState` = runtime state (cheap to create multiple)
- Multiple states CAN share the same context and run in parallel!

**Memory Cost Per Additional State** (from [whisper.cpp#272](https://github.com/ggml-org/whisper.cpp/issues/272)):

| Model | Model Weights (shared) | Per Additional State |
|-------|------------------------|---------------------|
| Base | ~215 MB | **+6 MB** |
| Medium | ~1720 MB | **+43 MB** |
| Large | ~4000 MB | **~100-150 MB** (estimated) |

Example for Large model:
- 1 state: 4.0GB + 0.1GB = 4.1GB
- 2 states: 4.0GB + 0.2GB = 4.2GB (NOT 8GB!)
- 3 states: 4.0GB + 0.3GB = 4.3GB

**Caveat: GPU Acceleration** (from [whisper.cpp#1408](https://github.com/ggml-org/whisper.cpp/issues/1408)):
When using Metal/CUDA GPU acceleration, parallel CPU states may **not help** because the GPU becomes the bottleneck. Parallel states are most beneficial for:
- CPU-only transcription
- Very long audio where pipelining helps

Your current code in [local_client.rs](src-tauri/src/models/local_client.rs:56) already does:
```rust
let mut state = self.context.create_state()?;
```

This could be extended to create multiple states for parallel processing.

**References:**
- [faster-whisper-acceleration](https://github.com/RomanKlimov/faster-whisper-acceleration) - Splits at silence for parallel processing
- [Modal's approach](https://modal.com/blog/faster-transcription) - VAD → chunk → parallel transcribe

### Approach 2: Speculative/Pipeline Transcription

**How it works:**
1. While still recording, detect "major pauses" (e.g., 2-3+ seconds of silence)
2. Treat completed segments as ready for transcription
3. Start transcribing earlier segments in background while recording continues
4. When user stops recording, most audio is ALREADY transcribed!
5. Only final segment needs processing

**Example timeline:**
```
Recording: [====Seg1====][===Seg2===][==Seg3==]
                ↓            ↓           ↓
Transcribe:     T1 starts    T2 starts   T3 starts when recording stops
                T1 done      T2 done     T3 done (short wait!)
```

**Advantages:**
- Works with ALL backends (including API with rate limits)
- No context loss within segments (Whisper sees full segment)
- Perceived latency near-zero for long recordings
- Uses larger chunks (2-3 min) → fewer API calls

### Approach 3: Hybrid Strategy

| Recording Length | Strategy |
|-----------------|----------|
| Short (<1 min) | Batch (current approach is fine) |
| Medium (1-5 min) | Pipeline: transcribe completed segments while recording |
| Long (>5 min) | Pipeline + parallel chunks for local model |

---

## Rate Limit Considerations (Azure 50 req/min)

With the **Pipeline approach using major-pause detection**:
- 10-minute recording → maybe 3-5 segments (not 100+)
- Well within Azure's 50 req/min limit
- Each segment is 1-3 minutes (maintains Whisper's context/post-processing)

---

## Conclusion

Based on your requirements:
- **All backends** (OpenAI, Azure, Local)
- **Cost-neutral** (same total audio = same cost)
- **Reduce latency** (not real-time display)

**Recommended: Pipeline/Speculative Transcription**

1. **Extend VAD to detect "major pauses"** (2-3+ seconds) as segment boundaries
2. **Create segment WAV files** as segments complete during recording
3. **Background transcribe** completed segments while recording continues
4. **Emit `transcriptionSegment` events** as each segment completes
5. **Final result available almost immediately** when recording stops

### For Local Whisper (bonus optimization):
- Use parallel transcription with multiple `WhisperState` instances
- Can process 2-3 segments simultaneously
- Further reduces latency for local model users

### Future Implementation Outline (when ready)

**Phase 1: Major Pause Detection**
- Add configurable `segment_silence_threshold` (e.g., 2000ms)
- Extend `SmoothedVad` to emit "segment boundary" events
- Create temporary segment WAV files

**Phase 2: Background Transcription Pipeline**
- New `TranscriptionPipeline` service
- Process segments as they complete
- Emit progress events to frontend

**Phase 3: Parallel Local Transcription (optional)**
- For local model: create multiple `WhisperState` from same context
- Use Rayon or tokio tasks for parallel processing

---

## Sources

### OpenAI / Azure APIs
- [OpenAI Realtime Transcription API](https://platform.openai.com/docs/guides/realtime-transcription)
- [OpenAI Speech to Text Guide](https://platform.openai.com/docs/guides/speech-to-text)
- [Azure OpenAI Realtime Audio](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/realtime-audio)
- [OpenAI Pricing](https://platform.openai.com/docs/pricing)

### Streaming/Real-time Solutions
- [whisper-flow GitHub](https://github.com/dimastatz/whisper-flow) - Tumbling window technique
- [faster-whisper GitHub](https://github.com/SYSTRAN/faster-whisper) - 4x faster, CTranslate2
- [WhisperLive GitHub](https://github.com/collabora/WhisperLive) - Real-time server
- [whisper_streaming GitHub](https://github.com/ufal/whisper_streaming) - Being replaced by SimulStreaming

### Latency Optimization
- [5 Ways to Speed Up Whisper Transcription (Modal)](https://modal.com/blog/faster-transcription) - Parallel chunking
- [faster-whisper-acceleration](https://github.com/RomanKlimov/faster-whisper-acceleration) - Split at silence for parallel processing
- [Cerebrium: Faster Whisper Transcription](https://www.cerebrium.ai/articles/faster-whisper-transcription-how-to-maximize-performance-for-real-time-audio-to-text)
- [Fireworks: 20x faster Whisper](https://fireworks.ai/blog/audio-transcription-launch)

### VAD
- [Silero VAD GitHub](https://github.com/snakers4/silero-vad)
- [LiveKit Silero VAD Plugin](https://docs.livekit.io/agents/build/turns/vad/)

### Rust/whisper-rs
- [whisper-rs GitHub](https://github.com/tazz4843/whisper-rs) - Rust bindings to whisper.cpp
- [whisper-rs Docs](https://docs.rs/whisper-rs/0.15.1/whisper_rs/)
