import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Tailwind-styled markdown rendering for assistant messages (no typography plugin).
const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-base font-bold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 text-sm font-bold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="ml-1">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // Block-level code carries a language-* class from fenced blocks.
    const isBlock = (className ?? '').includes('language-')
    return isBlock ? (
      <code className={`whitespace-pre-wrap break-words font-mono ${className ?? ''}`}>{children}</code>
    ) : (
      <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-[13px] break-words">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-hidden whitespace-pre-wrap break-words rounded-lg bg-foreground px-2 py-1.5 text-[13px] text-background last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border pl-2 text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  table: ({ children }) => (
    <table className="mb-2 w-full border-collapse text-[13px] last:mb-0">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-1.5 py-0.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-1.5 py-0.5">{children}</td>
  ),
}

// Escape stray single tildes so GFM doesn't pair two distant `~` (e.g. `199~217` and `6~24px`)
// into a strikethrough span. Real `~~deleted~~` syntax and code spans/fences are left untouched.
const strayTilde = /(?<!~)~(?!~)/g
const codeSpan = /`+/g

function escapeStrayTildes(text: string): string {
  let out = ''
  let plain = 0
  for (let m = codeSpan.exec(text); m; m = codeSpan.exec(text)) {
    // Find the closing run of the same length to form a code span/fence.
    const close = text.slice(m.index + m[0].length).match(new RegExp('`{' + m[0].length + '}(?!`)'))
    if (!close) continue // Unpaired backticks: treat the rest as plain text.
    const end = m.index + m[0].length + (close.index ?? 0) + m[0].length
    out += text.slice(plain, m.index).replace(strayTilde, '\\~') + text.slice(m.index, end)
    plain = end
    codeSpan.lastIndex = end
  }
  return out + text.slice(plain).replace(strayTilde, '\\~')
}

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {escapeStrayTildes(text)}
    </ReactMarkdown>
  )
}
