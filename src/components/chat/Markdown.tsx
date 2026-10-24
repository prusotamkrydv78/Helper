import { memo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "./CopyButton";

function CodeBlock({ children, language }: { children: ReactNode; language: string }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-code-bg">
      <div className="flex h-8 items-center justify-between border-b border-border bg-surface-2/60 pl-3 pr-1">
        <span className="font-mono text-[11px] text-fg-subtle">{language || "text"}</span>
        <CopyButton getText={() => ref.current?.textContent ?? ""} label="Copy code" />
      </div>
      <pre ref={ref} className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre({ children }) {
    // react-markdown renders <pre><code class="language-x">…</code></pre>
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      typeof child === "object" && child && "props" in child
        ? String((child.props as { className?: string }).className ?? "")
        : "";
    const language = /language-([\w-]+)/.exec(className)?.[1] ?? "";
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  a({ children, href }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
