import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { DecorationSet } from '@tiptap/pm/view'
import { generatedDecorations } from '@shared/generatedLines'

// The enhanced-notes editor's grey lines (see src/shared/generatedLines.ts), recomputed whenever the text changes.

export const generatedLinesKey = new PluginKey<DecorationSet>('generatedLines')

export const GeneratedLines = Extension.create<{ isGenerated: (text: string) => boolean }>({
  name: 'generatedLines',
  addOptions() {
    return { isGenerated: () => false }
  },
  addProseMirrorPlugins() {
    const { isGenerated } = this.options
    return [
      new Plugin({
        key: generatedLinesKey,
        state: {
          init: (_, state) => generatedDecorations(state.doc, isGenerated),
          apply: (tr, old, _, state) => (tr.docChanged ? generatedDecorations(state.doc, isGenerated) : old)
        },
        props: {
          decorations: (state) => generatedLinesKey.getState(state)
        }
      })
    ]
  }
})
