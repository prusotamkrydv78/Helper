import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/Button";
import { useToast } from "../ui/overlays";

export function CopyButton({ getText, label = "Copy" }: { getText: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      className="h-6 px-2 text-[11px]"
      icon={copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setCopied(true);
        } catch {
          toast("Couldn't access the clipboard", "error");
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
