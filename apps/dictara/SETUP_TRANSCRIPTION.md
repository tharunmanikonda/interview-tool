# Audio Transcription Setup Guide

This guide will help you set up and test the new OpenAI audio transcription feature.

## 🎯 What Was Implemented

Your Dictara app now automatically transcribes recorded audio using OpenAI's Whisper API!

**Flow:**
1. User presses FN key → Recording starts
2. User releases FN key → Recording stops
3. Audio is automatically sent to OpenAI Whisper API
4. Transcribed text appears in the UI
5. User can copy the transcription to clipboard

## 📋 Setup Steps

### 1. Get OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Sign in or create an account
3. Click "Create new secret key"
4. Copy the API key (starts with `sk-...`)

### 2. Configure Environment Variables

Open the `.env` file in the project root and add your API key:

```bash
OPENAI_API_KEY=your-openai-api-key-here
```

**Important:** The `.env` file is already in `.gitignore`, so your API key won't be committed to git! 🔒

### 3. Install Dependencies

Run this command to download the new Rust dependencies:

```bash
cd src-tauri
cargo build
```

This will install:
- `async-openai` - OpenAI API client
- `tokio` - Async runtime
- `dotenvy` - Environment variable loader

### 4. Run the App

```bash
npm run tauri dev
```

## 🧪 Testing

1. **Check Console Output** - When the app starts, you should see:
   ```
   ✅ OpenAI client initialized successfully
   ```

   If you see a warning instead, check that your API key is set correctly in `.env`

2. **Record Audio**:
   - Press and hold the FN key
   - Speak something (e.g., "Hello, this is a test")
   - Release the FN key

3. **Watch the Transcription**:
   - You'll see "🎙️ Transcribing audio..." appear
   - After a few seconds, your transcribed text will appear
   - Click "📋 Copy" to copy the text to clipboard

4. **Check Console Logs**:
   ```
   [Audio] FN key pressed - starting recording
   [Audio Recorder] Starting recording...
   [Audio] FN key released - stopping recording
   [Transcription] Recording stopped: recording_xxx.wav (2500ms)
   [OpenAI Client] Transcribing: recording_xxx.wav (duration: 2500ms)
   [OpenAI Client] Transcription successful: 42 characters
   [Transcription] ✅ Success: Hello, this is a test
   ```

## 🎨 UI Features

The transcription section shows:

- **Loading state** (blue): "🎙️ Transcribing audio..."
- **Success state** (green): Shows transcribed text with copy button
- **Error state** (red): Shows error message
- **Empty state** (gray): Instructions to get started

## ⚠️ Edge Cases Handled

The implementation includes validation for:

1. **Audio too short** (< 0.5 seconds)
   - Shows error: "Audio too short: XXXms (minimum 500ms)"

2. **File too large** (> 25MB)
   - Shows error: "File too large: XXX bytes (maximum 25MB)"

3. **API errors** (network issues, rate limits, invalid key)
   - Shows specific error message
   - Audio file is preserved for manual retry

4. **Missing API key**
   - Transcription disabled gracefully
   - Warning shown in console

See `notes/edge-cases-to-improve.md` for future enhancements!

## 💰 Cost Information

OpenAI Whisper API pricing:
- **$0.006 per minute** of audio
- 10-second recording = $0.001 (0.1 cents)
- Very affordable for testing!

## 🔍 Debugging

If transcription isn't working:

1. **Check API Key**:
   ```bash
   # Make sure .env exists and has your key
   cat .env
   ```

2. **Check Console**:
   - Look for "✅ OpenAI client initialized successfully"
   - Look for transcription logs starting with `[Transcription]`

3. **Check Audio Files**:
   ```bash
   ls -lh audio/
   ```
   Audio files should be created in the `audio/` directory

4. **Test API Key Manually**:
   ```bash
   curl https://api.openai.com/v1/models \
     -H "Authorization: Bearer $OPENAI_API_KEY"
   ```

5. **Common Issues**:
   - **"API key missing"**: Check `.env` file exists and has `OPENAI_API_KEY`
   - **"Audio too short"**: Hold FN key longer (at least 0.5 seconds)
   - **"API error"**: Check internet connection and API key validity

## 📁 Files Modified/Created

### New Files:
- `.env` - Environment variables (contains your API key)
- `src-tauri/src/openai_client.rs` - OpenAI Whisper integration
- `notes/edge-cases-to-improve.md` - Future improvement ideas
- `SETUP_TRANSCRIPTION.md` - This file!

### Modified Files:
- `src-tauri/Cargo.toml` - Added dependencies
- `src-tauri/src/lib.rs` - Added transcription logic
- `src/App.tsx` - Added transcription UI
- `.gitignore` - Added `.env` to ignore list

## 🚀 Next Steps

Try these ideas:
1. Record a longer message
2. Try different languages (Whisper supports 90+ languages!)
3. Test with background noise
4. Check the edge cases in `notes/edge-cases-to-improve.md`

## 💡 Tips

- The transcribed text is also logged to the console for debugging
- Each recording is saved as `recording_[timestamp].wav` in the `audio/` folder
- You can review old recordings and manually transcribe them if needed
- The "Copy" button makes it easy to paste transcriptions into other apps

---

**Happy transcribing!** 🎉

If you run into any issues, check the console output first - it has detailed logging for every step of the process.
