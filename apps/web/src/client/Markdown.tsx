// Renders agent prose as real markdown — headings, lists, tables, links, and
// code blocks with syntax highlighting + a copy button. This is what makes the
// agent's output read like a document instead of a raw text dump.
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // The <code> child carries the raw text content.
    const text = extractText(children);
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="code-block">
      <button className="code-copy" onClick={copy} aria-label="Copy code">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      {/* If markdown parsing/rendering ever throws, show the raw text rather than
          blanking the message. */}
      <ErrorBoundary fallback={<pre className="markdown-fallback">{text}</pre>}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          components={{
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </ErrorBoundary>
    </div>
  );
});
