import { Fragment, type ReactNode } from 'react'

/**
 * Renderizador mínimo de markdown: bloques de código, código en línea, negrita
 * y listas. Devuelve elementos de React — nunca HTML crudo — así que el texto
 * del modelo no puede inyectar marcado en la página.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = splitFences(text)
  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <pre key={i} className="code">
            {block.lang ? <span className="code-lang">{block.lang}</span> : null}
            <code>{block.content}</code>
          </pre>
        ) : (
          <Paragraphs key={i} text={block.content} />
        ),
      )}
    </>
  )
}

type Block = { type: 'text' | 'code'; content: string; lang?: string }

function splitFences(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split('\n')
  let buffer: string[] = []
  let code: string[] | null = null
  let lang = ''

  const flushText = () => {
    if (buffer.length) blocks.push({ type: 'text', content: buffer.join('\n') })
    buffer = []
  }

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      if (code) {
        blocks.push({ type: 'code', content: code.join('\n'), lang })
        code = null
        lang = ''
      } else {
        flushText()
        code = []
        lang = fence[1] ?? ''
      }
      continue
    }
    if (code) code.push(line)
    else buffer.push(line)
  }

  if (code) blocks.push({ type: 'code', content: code.join('\n'), lang })
  flushText()
  return blocks
}

function Paragraphs({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={i} className="md-gap" />
        const bullet = trimmed.match(/^[-*]\s+(.*)$/)
        const heading = trimmed.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          return (
            <p key={i} className="md-heading">
              <Inline text={heading[2]} />
            </p>
          )
        }
        if (bullet) {
          return (
            <p key={i} className="md-bullet">
              <span className="md-dot">•</span>
              <span>
                <Inline text={bullet[1]} />
              </span>
            </p>
          )
        }
        return (
          <p key={i} className="md-line">
            <Inline text={trimmed} />
          </p>
        )
      })}
    </>
  )
}

function Inline({ text }: { text: string }): ReactNode {
  const parts: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    const token = match[0]
    if (token.startsWith('`')) {
      parts.push(
        <code key={match.index} className="inline-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>)
    }
    cursor = match.index + token.length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))

  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </>
  )
}
