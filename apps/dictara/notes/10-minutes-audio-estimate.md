# 10-Minute Audio File Size Estimate

Let me calculate the file size for a 10-minute recording at 48kHz:

## Audio specifications (based on your current setup):
- Sample rate: 48,000 Hz (48kHz)
- Channels: 1 (mono) or 2 (stereo) - depends on your mic
- Bit depth: 16-bit (2 bytes per sample)

## File size calculation:

### For mono (1 channel):
- Bytes per second = 48,000 samples/sec × 2 bytes × 1 channel = **96,000 bytes/sec**
- Bytes per minute = 96,000 × 60 = **5.76 MB/min**
- **10 minutes = ~57.6 MB**

### For stereo (2 channels):
- Bytes per second = 48,000 samples/sec × 2 bytes × 2 channels = **192,000 bytes/sec**
- Bytes per minute = 192,000 × 60 = **11.52 MB/min**
- **10 minutes = ~115.2 MB**

## OpenAI Whisper API Limit Consideration

Good news: This is well under the OpenAI Whisper API limit of 25 MB... wait, actually it exceeds it! =

For recordings longer than about **4 minutes** (for mono) or **2 minutes** (for stereo), you'd exceed the 25MB Whisper limit and would need to:

1. Split the file into chunks
2. Compress to MP3/OGG
3. Or downsample to 16kHz (which would give you ~12 MB for 10 minutes mono)

## Next Steps

Would you like me to add automatic downsampling to 16kHz to keep files smaller and always compatible with Whisper's limit?
