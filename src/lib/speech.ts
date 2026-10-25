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

export function speak(text: string, voiceName: string, rate: number) {
  if (typeof speechSynthesis === "undefined") return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(speakable(text));
  const v = voices().find((x) => x.name === voiceName);
  if (v) u.voice = v;
  u.rate = Math.min(2, Math.max(0.5, rate || 1));
  speechSynthesis.speak(u);
}

/** Interrupts any reply being spoken. */
export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
