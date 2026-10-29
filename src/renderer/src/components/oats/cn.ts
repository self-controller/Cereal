import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge has to know Cereal's custom utilities, or it would treat `text-h3` as a colour and drop
// `text-ink-primary`, or treat `ring-focus-ring` as a ring colour.
const merge = extendTailwindMerge<'focus-ring'>({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'h1', 'h2', 'h3', 'lg-slab', 'editor', 'editor-sm'] }],
      'focus-ring': ['ring-focus-ring', 'ring-focus-ring-inset', 'ring-focus-ring-inset-within']
    }
  }
})

type ClassValue = string | boolean | null | undefined | 0 | 0n

/** Join class names, letting later Tailwind utilities override earlier ones. */
export function cn(...classes: ClassValue[]): string {
  return merge(classes.filter((c): c is string => typeof c === 'string' && c !== '').join(' '))
}
