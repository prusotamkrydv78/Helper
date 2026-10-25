import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Mic, MicOff, Paperclip, Square, X } from "lucide-react";
import { featureService, type Skill } from "../../services/tauri/assistant";
import { useWorkflows } from "../../store/WorkflowStore";
import { stopSpeaking } from "../../lib/speech";
import type { Attachment } from "../../types";
import { cn, formatBytes, uid } from "../../lib/utils";
import { useStore } from "../../store/AppStore";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/primitives";
import { Tooltip, useToast } from "../ui/overlays";

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
}

const MAX_FILES = 5;
const MAX_SIZE = 25 * 1024 * 1024;

export const Composer = forwardRef<ComposerHandle, { streaming: boolean; onStop: () => void; large?: boolean }>(
  function Composer({ streaming, onStop, large }, ref) {
    const { state, actions } = useStore();
    const toast = useToast();
    const [text, setText] = useState("");
    const [files, setFiles] = useState<Attachment[]>([]);
    const ta = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const sendOnEnter = state.settings.sendOnEnter;
    const [listening, setListening] = useState(false);

    /** Push-to-talk: one utterance via Windows speech recognition (nothing is recorded to disk). */
    const listen = () => {
      if (listening) {
        void featureService.voiceCancel();
        return;
      }
      stopSpeaking(); // interrupt a reply being read aloud
      setListening(true);
      void featureService
        .voiceListen()
        .then((heard) => {
          const t = heard.trim();
          if (!t) return;
          if (state.settings.autoSendVoice && !streaming) actions.sendMessage(t);
          else setText((cur) => (cur.trim() ? `${cur} ${t}` : t));
        })
        .catch((e) => {
          if (e?.kind !== "cancelled") toast(e?.message ?? "Voice input failed", "error");
        })
        .finally(() => setListening(false));
    };
    const listenRef = useRef(listen);
    listenRef.current = listen;
    // The global "voice" shortcut starts push-to-talk here.
    useEffect(() => {
      const start = () => state.settings.voiceInput && !state.settings.voiceConversation && listenRef.current();
      window.addEventListener("jarvis:voice", start);
      return () => window.removeEventListener("jarvis:voice", start);
    }, [state.settings.voiceInput, state.settings.voiceConversation]);

    useImperativeHandle(ref, () => ({
      focus: () => ta.current?.focus(),
      setText: (t) => {
        setText(t);
        requestAnimationFrame(() => {
          ta.current?.focus();
          ta.current?.setSelectionRange(t.length, t.length);
        });
      },
    }));

    // Auto-grow up to a max height.
    useLayoutEffect(() => {
      const el = ta.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
    }, [text]);

    const canSend = text.trim().length > 0 && !streaming;
    const suggestions = useSuggestions(text);

    function submit() {
      if (!canSend) return;
      actions.sendMessage(text, files);
      setText("");
      setFiles([]);
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
      const modifier = e.ctrlKey || e.metaKey;
      if ((sendOnEnter && !e.shiftKey) || (!sendOnEnter && modifier)) {
        e.preventDefault();
        submit();
      }
    }

    function onFiles(list: FileList | null) {
      if (!list) return;
      const next: Attachment[] = [];
      for (const f of Array.from(list)) {
        if (f.size > MAX_SIZE) {
          toast(`${f.name} is larger than 25 MB`, "error");
          continue;
        }
        next.push({ id: uid("file"), name: f.name, size: f.size, type: f.type });
      }
      setFiles((cur) => {
        const merged = [...cur, ...next];
        if (merged.length > MAX_FILES) toast(`You can attach up to ${MAX_FILES} files`, "error");
        return merged.slice(0, MAX_FILES);
      });
      if (fileInput.current) fileInput.current.value = "";
    }

    return (
      <div className="w-full">
        <div
          className={cn(
            "rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.15)] transition-[border-color,box-shadow]",
            "focus-within:border-border-strong focus-within:shadow-pop",
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFiles(e.dataTransfer.files);
          }}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {files.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pl-2 pr-1 text-xs animate-pop"
                >
                  <Paperclip className="size-3 text-fg-subtle" />
                  <span className="max-w-40 truncate">{f.name}</span>
                  <span className="text-fg-subtle">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((xs) => xs.filter((x) => x.id !== f.id))}
                    className="cursor-pointer rounded p-0.5 text-fg-subtle hover:bg-surface-3 hover:text-fg"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            aria-label="Message"
            placeholder={large ? "Describe a task, or ask anything…" : "Message the assistant…"}
            className={cn(
              "block w-full resize-none bg-transparent px-4 pt-3.5 text-[0.95rem] leading-relaxed text-fg outline-none placeholder:text-fg-subtle",
              large ? "min-h-[84px]" : "min-h-[52px]",
            )}
          />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1 text-xs">
              <span className="text-fg-subtle">Matching:</span>
              {suggestions.map((sg) => (
                <button
                  key={sg.key}
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 hover:bg-surface-2"
                  title={`Runs “${sg.label}” as a workflow (its steps still ask before consequential actions)`}
                  onClick={() => {
                    try {
                      sg.run();
                      setText("");
                      toast(`Started “${sg.label}”. Follow it on the Workflows page.`, "success");
                    } catch (e) {
                      toast(e instanceof Error ? e.message : "Couldn't start it", "error");
                    }
                  }}
                >
                  ▶ {sg.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex items-center gap-1">
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
              <Tooltip label="Attach files (names only in demo)">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Attach files"
                  icon={<Paperclip className="size-4" />}
                  onClick={() => fileInput.current?.click()}
                />
              </Tooltip>
              {state.settings.voiceInput && (
                <Tooltip label={listening ? "Listening… click to cancel" : "Speak (push to talk)"}>
                  <Button
                    size="icon"
                    variant={listening ? "primary" : "ghost"}
                    aria-label={listening ? "Cancel voice input" : "Voice input"}
                    aria-pressed={listening}
                    className={listening ? "animate-pulse" : undefined}
                    icon={listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                    onClick={listen}
                  />
                </Tooltip>
              )}
            </div>
            <div className="flex items-center gap-2.5">
              <span className="hidden items-center gap-1 text-[11px] text-fg-subtle sm:flex">
                {sendOnEnter ? (
                  <>
                    <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
                  </>
                ) : (
                  <>
                    <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> send
                  </>
                )}
              </span>
              {streaming ? (
                <Tooltip label="Stop generating">
                  <Button
                    size="icon"
                    variant="secondary"
                    aria-label="Stop generating"
                    className="rounded-full"
                    icon={<Square className="size-3.5 fill-current" />}
                    onClick={onStop}
                  />
                </Tooltip>
              ) : (
                <Button
                  size="icon"
                  variant="primary"
                  aria-label="Send message"
                  className="rounded-full"
                  disabled={!canSend}
                  icon={<ArrowUp className="size-4" />}
                  onClick={submit}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);

/** Existing skills and workflow templates whose name/description match what's being typed. Nothing runs until clicked. */
function useSuggestions(text: string): { key: string; label: string; run: () => void }[] {
  const { workflows, actions: wf } = useWorkflows();
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    void featureService.skillsLoad().then(setSkills).catch(() => {});
  }, []);
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  if (words.length < 2) return [];
  const score = (hay: string) => {
    const h = hay.toLowerCase();
    return words.filter((w) => h.includes(w)).length;
  };
  const out: { key: string; label: string; score: number; run: () => void }[] = [];
  for (const sk of skills.filter((x) => x.enabled && x.steps.length)) {
    const sc = score(`${sk.name} ${sk.description}`);
    if (sc >= 2)
      out.push({ key: sk.id, label: sk.name, score: sc, run: () => wf.start(wf.create({ title: `Skill: ${sk.name}`, goal: sk.description || sk.name, steps: sk.steps })) });
  }
  for (const w of workflows.filter((x) => x.template)) {
    const sc = score(`${w.title} ${w.goal}`);
    if (sc >= 2) out.push({ key: w.id, label: w.title, score: sc, run: () => void wf.runCopy(w.id, "suggested", "manual") });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
