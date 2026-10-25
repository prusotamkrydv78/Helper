// Text-to-speech with the system voices (Web Speech synthesis, supported by WebView2).

export function voices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices();
}

/** Plain text for speaking: no code blocks, links or markdown symbols. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_`>|~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

/** True while a hands-free conversation runs; it speaks replies itself. */
export const conversation = { active: false };

/** Speaks text; resolves when finished or interrupted. */
export function speak(text: string, voiceName: string, rate: number): Promise<void> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve();
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(speakable(text));
  const v = voices().find((x) => x.name === voiceName);
  if (v) u.voice = v;
  u.rate = Math.min(2, Math.max(0.5, rate || 1));
  return new Promise((resolve) => {
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

/** Interrupts any reply being spoken. */
export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
