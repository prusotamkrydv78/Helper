import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Volume2 } from "lucide-react";
import { useStore } from "../../store/AppStore";
import { featureService } from "../../services/tauri/assistant";
import { conversation, speak, stopSpeaking } from "../../lib/speech";
import { Button } from "../ui/Button";
import { useToast } from "../ui/overlays";

type Phase = "off" | "waiting" | "listening" | "thinking" | "speaking";

const LABEL: Record<Phase, string> = {
  off: "Hands-free off",
  waiting: "Waiting for wake phrase",
  listening: "Listening…",
  thinking: "Working on it…",
  speaking: "Speaking…",
};
const END_PHRASES = ["stop listening", "goodbye", "that's all", "end conversation"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hands-free conversation: (wake phrase →) listen → send → wait for the reply → speak it →
 * listen again for a follow-up. Windows speech recognition ends an utterance after a short
 * silence (voice activity detection). The pill shows when the microphone is active; Mute
 * stops everything immediately. Nothing is recorded to disk.
 */
export function VoiceController() {
  const { state, actions } = useStore();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("off");
  const running = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const s = state.settings;

  const mute = () => {
    running.current = false;
    conversation.active = false;
    stopSpeaking();
    void featureService.voiceCancel();
    setPhase("off");
  };

  // Turning the feature off ends a running conversation.
  useEffect(() => {
    if (!s.voiceConversation && running.current) mute();
  }, [s.voiceConversation]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (running.current) return;
    running.current = true;
    conversation.active = true;
    try {
      while (running.current) {
        const st = stateRef.current.settings;
        let heard = "";
        if (st.wakePhrase.trim()) {
          setPhase("waiting");
          heard = await featureService.voiceWaitForPhrase(st.wakePhrase);
          if (!running.current) break;
        }
        if (!heard) {
          setPhase("listening");
          try {
            heard = (await featureService.voiceListen()).trim();
          } catch (e) {
            const msg = String((e as { message?: string })?.message ?? "");
            if (!running.current || (e as { kind?: string })?.kind === "cancelled") break;
            // Silence: in follow-up mode, go back to waiting for the wake phrase (or stop without one).
            if (msg.includes("Didn't hear") && st.wakePhrase.trim()) continue;
            throw e;
          }
        }
        if (!running.current || !heard) break;
        if (END_PHRASES.some((p) => heard.toLowerCase().includes(p))) break;
        setPhase("thinking");
        const before = new Set(stateRef.current.conversations.flatMap((c) => c.messages.map((m) => m.id)));
        actions.sendMessage(heard);
        // Wait for the reply to finish.
        let reply = "";
        for (let i = 0; i < 1200 && running.current; i++) {
          await sleep(250);
          const cur = stateRef.current;
          const conv = cur.conversations.find((c) => c.id === cur.ui.activeConversationId);
          const msg = conv?.messages.find((m) => m.role === "assistant" && !before.has(m.id));
          if (msg && msg.status !== "streaming") {
            reply = msg.error ? `Sorry, that failed: ${msg.error}` : msg.content;
            break;
          }
        }
        if (!running.current) break;
        if (reply.trim()) {
          setPhase("speaking");
          await speak(reply, st.voiceName, st.speechRate);
        }
      }
    } catch (e) {
      toast((e as { message?: string })?.message ?? "Voice conversation stopped", "error");
    } finally {
      running.current = false;
      conversation.active = false;
      setPhase("off");
    }
  };

  // The "voice" global shortcut starts hands-free mode when it's enabled.
  useEffect(() => {
    const onVoice = () => s.voiceConversation && void start();
    window.addEventListener("jarvis:voice", onVoice);
    return () => window.removeEventListener("jarvis:voice", onVoice);
  }, [s.voiceConversation]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s.voiceConversation) return null;
  const micOn = phase === "waiting" || phase === "listening";
  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm shadow-lg"
      role="status"
      aria-live="polite"
    >
      <span className={micOn ? "flex items-center gap-1.5 text-danger" : "flex items-center gap-1.5 text-fg-muted"}>
        {phase === "speaking" ? <Volume2 className="size-4" /> : micOn ? <Mic className="size-4 animate-pulse" /> : <MicOff className="size-4" />}
        {micOn ? "Microphone on · " : ""}
        {LABEL[phase]}
      </span>
      {phase === "off" ? (
        <Button size="sm" variant="primary" onClick={() => void start()}>
          Start hands-free
        </Button>
      ) : (
        <Button size="sm" variant="danger" onClick={mute}>
          Mute
        </Button>
      )}
    </div>
  );
}
