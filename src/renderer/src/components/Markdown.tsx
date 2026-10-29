import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { call } from '../lib/api'
import { parseLines } from '@shared/markdown'
import { BLOCK_IN, PULSE_LINE_STEP_MS } from '@shared/motion'
import { cn, motion } from './oats'

// A small line-oriented Markdown renderer for model output (chat answers, the enhanced-notes stream).
// React escaping keeps model output inert.

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|~~[^~]+~~|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[\d{1,2}\])/g

export function Inline({ text, onCite }: { text: string; onCite?: (n: number) => void }): ReactNode {
  const parts = text.split(INLINE)
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null
        if (/^(\*\*|__).+\1$/.test(p)) return <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>
        if (/^`.+`$/.test(p)) return <code key={i} className="rounded border-[0.5px] border-hairline bg-highlight px-1 font-mono text-[0.85em]">{p.slice(1, -1)}</code>
        if (/^~~.+~~$/.test(p)) return <s key={i}>{p.slice(2, -2)}</s>
        const cite = p.match(/^\[(\d{1,2})\]$/)
        if (cite && onCite)
          return (
            <button key={i} onClick={() => onCite(Number(cite[1]))} className="mx-0.5 rounded bg-surface-tint-accent px-1 align-[1px] text-2xs font-semibold text-ink-accent-strong hover:bg-fill-accent hover:text-ink-primary-inverse-static">
              {cite[1]}
            </button>
          )
        const link = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)
        if (link)
          return (
            <a key={i} href={link[2]} onClick={(e) => (e.preventDefault(), void call('app:open-external', link[2]))} className="text-ink-accent-strong underline-offset-2 hover:underline">
              {link[1]}
            </a>
          )
        if (/^(\*|_).+\1$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>
        return <Fragment key={i}>{p}</Fragment>
      })}
    </>
  )
}

/**
 * How blocks appear. 'blur-in': each block fades and unblurs in as it mounts, for text that is still streaming (lines
 * keep their keys, so only new ones animate). 'pulse': a grey band sweeps through every line, each starting a little
 * after the one above, for the user's notes while new notes are being written from them.
 */
export type Reveal = 'none' | 'blur-in' | 'pulse'

type BlockTag = 'div' | 'p' | 'pre' | 'hr'
const BLUR_IN = { initial: { opacity: 0, filter: 'blur(2px)' }, animate: { opacity: 1, filter: 'blur(0px)' }, transition: BLOCK_IN }

function Block({ as, reveal, order, className, style, children }: { as: BlockTag; reveal: Reveal; order: number; className?: string; style?: CSSProperties; children?: ReactNode }): ReactNode {
  if (reveal === 'blur-in') {
    const M = motion[as]
    return (
      <M className={className} style={style} {...BLUR_IN}>
        {children}
      </M>
    )
  }
  const Tag = as
  if (reveal === 'pulse')
    return (
      <Tag className={cn(className, 'grayscale-text-pulse')} style={{ ...style, animationDelay: `${order * PULSE_LINE_STEP_MS}ms` }}>
        {children}
      </Tag>
    )
  return (
    <Tag className={className} style={style}>
      {children}
    </Tag>
  )
}

export function Markdown({ text, onCite, className = '', reveal = 'none' }: { text: string; onCite?: (n: number) => void; className?: string; reveal?: Reveal }): ReactNode {
  const lines = parseLines(text)
  let order = 0
  return (
    <div className={`selectable text-[15px] leading-[1.6] ${className}`}>
      {lines.map((l, i) => {
        const prev = lines[i - 1]
        const b = { reveal, order: l.kind === 'blank' || l.kind === 'rule' ? order : order++ }
        switch (l.kind) {
          case 'heading':
            return (
              <Block key={l.index} {...b} as="div" className={`prose-heading font-semibold ${prev && prev.kind !== 'blank' ? 'mt-4' : i > 0 ? 'mt-2' : ''} mb-1 text-ink-primary`}>
                <Inline text={l.text} onCite={onCite} />
              </Block>
            )
          case 'bullet':
            return (
              <Block key={l.index} {...b} as="div" className="flex gap-2" style={{ paddingLeft: l.indent * 20 }}>
                <span className="mt-[0.1em] w-3 shrink-0 select-none text-center text-ink-secondary">{l.checked === undefined ? (l.indent ? '◦' : '•') : l.checked ? '☑' : '☐'}</span>
                <span className={l.checked ? 'text-ink-secondary line-through' : ''}>
                  <Inline text={l.text} onCite={onCite} />
                </span>
              </Block>
            )
          case 'ordered':
            return (
              <Block key={l.index} {...b} as="div" className="flex gap-2" style={{ paddingLeft: l.indent * 20 }}>
                <span className="w-4 shrink-0 select-none text-right text-ink-secondary">{l.n}.</span>
                <span>
                  <Inline text={l.text} onCite={onCite} />
                </span>
              </Block>
            )
          case 'quote':
            return (
              <Block key={l.index} {...b} as="div" className="border-l-2 border-ink-accent-strong pl-4">
                <Inline text={l.text} onCite={onCite} />
              </Block>
            )
          case 'code':
            return (
              <Block key={l.index} {...b} as="pre" className="bg-highlight px-3 font-mono text-sm whitespace-pre-wrap">
                {l.text || ' '}
              </Block>
            )
          case 'rule':
            return <Block key={l.index} {...b} as="hr" className="my-3 border-hairline" />
          case 'blank':
            return <div key={l.index} className="h-2" />
          case 'para':
            return (
              <Block key={l.index} {...b} as="p">
                <Inline text={l.text} onCite={onCite} />
              </Block>
            )
        }
      })}
    </div>
  )
}
