type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export type SpeechCallbacks = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: string) => void;
};

export class BrowserSpeechProvider {
  private recognition?: SpeechRecognitionLike;
  private shouldRestart = false;
  private retryAfterAbort = false;

  support(): { ok: true } | { ok: false; reason: string } {
    const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Constructor) {
      return { ok: false, reason: "Browser speech recognition is unavailable in this Chrome profile." };
    }
    return { ok: true };
  }

  async start(callbacks: SpeechCallbacks) {
    const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Constructor) {
      throw new Error("Browser speech recognition is unavailable.");
    }

    this.stop();
    this.shouldRestart = true;
    this.retryAfterAbort = true;

    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let partial = "";
      let final = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript || "";
        if (result.isFinal) final += transcript;
        else partial += transcript;
      }

      if (partial.trim()) callbacks.onPartial(partial);
      if (final.trim()) callbacks.onFinal(final);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech") return;
      if (event.error === "network") {
        this.shouldRestart = false;
        callbacks.onError("Speech recognition service is unavailable in this browser/session. Use typed notes for now, or test mic in Chrome.");
        return;
      }
      if (event.error === "aborted") {
        if (this.retryAfterAbort) {
          this.retryAfterAbort = false;
          window.setTimeout(() => {
            if (!this.shouldRestart) return;
            try {
              recognition.start();
              callbacks.onError("Microphone restarted after Chrome aborted the first attempt.");
            } catch {
              this.shouldRestart = false;
              callbacks.onError("Chrome aborted microphone speech recognition. Try the typed input, or test in Chrome instead of Arc.");
            }
          }, 650);
          return;
        }

        this.shouldRestart = false;
        callbacks.onError("Chrome aborted microphone speech recognition. Try the typed input, or test in Chrome instead of Arc.");
        return;
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.shouldRestart = false;
        callbacks.onError("Microphone permission is blocked for this page/profile.");
        return;
      }
      callbacks.onError(event.message || event.error || "Speech recognition failed.");
    };

    recognition.onend = () => {
      if (!this.shouldRestart) return;
      window.setTimeout(() => {
        try {
          recognition.start();
        } catch {
          this.shouldRestart = false;
        }
      }, 250);
    };

    this.recognition = recognition;
    recognition.start();
  }

  stop() {
    this.shouldRestart = false;
    this.retryAfterAbort = false;
    this.recognition?.stop();
    this.recognition = undefined;
  }
}

export async function testMicrophoneAccess(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true };
  } catch {
    return { ok: false, reason: "Browser microphone permission is blocked or unavailable for this page." };
  }
}

export type TabAudioCallbacks = {
  onLevel: (level: number) => void;
  onError: (error: string) => void;
};

export class TabAudioCaptureProvider {
  private stream?: MediaStream;
  private audioContext?: AudioContext;
  private raf = 0;

  async start(callbacks: TabAudioCallbacks) {
    this.stop();

    const response = await chrome.runtime.sendMessage({ type: "gptd:get-tab-audio-stream-id" });
    if (!response?.ok || !response.streamId) {
      throw new Error(response?.error || "Tab audio capture was denied or unavailable.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.streamId
        }
      } as MediaTrackConstraints,
      video: false
    });

    this.stream = stream;
    this.startMeter(stream, callbacks);
  }

  stop() {
    window.cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    void this.audioContext?.close();
    this.audioContext = undefined;
  }

  private startMeter(stream: MediaStream, callbacks: TabAudioCallbacks) {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(stream);
    const destination = context.createMediaStreamDestination();
    const data = new Uint8Array(analyser.frequencyBinCount);

    analyser.fftSize = 512;
    source.connect(analyser);
    source.connect(destination);
    this.audioContext = context;

    const tick = () => {
      try {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = value - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length) / 128;
        callbacks.onLevel(Math.min(1, rms * 3));
        this.raf = window.requestAnimationFrame(tick);
      } catch {
        callbacks.onError("Tab audio meter stopped unexpectedly.");
      }
    };

    tick();
  }
}
