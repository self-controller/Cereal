// Cereal's own prompts. (Granola's prompts live on its servers and were never seen or used.)
import type { PromptVariables } from './variables'
import { NO_CONTEXT } from '@shared/transcriptSummary'

function lines(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join('\n')
}

export function enhanceSystemPrompt(v: PromptVariables, extraInstructions?: string): string {
  const structure = v.summary_headings
    ? lines(
        `Organise the notes under these headings, in this order. Each heading is followed by what belongs under it:`,
        v.summary_headings,
        `Use the heading text exactly as given (without the description). Leave out a heading only if nothing relevant came up.`
      )
    : lines(
        `Choose up to ${v.max_num_headings} headings that match the main topics actually discussed, in the order they came up.`,
        v.headers.length > 0 && `The user wrote these headings themselves; keep them and use them first: ${v.headers.join(', ')}.`,
        v.is_lecture
          ? `If assignments, readings, deadlines or exam topics were mentioned, finish with a "### To review" heading listing them.`
          : `If any next steps or action items were agreed, finish with a "### Next steps" heading listing each with its owner.`
      )
  // my_name falls back to "Me" (the meeting transcript label), which reads badly in prose.
  const listener = v.my_name === 'Me' ? 'the user' : v.my_name
  return lines(
    v.is_lecture
      ? `You turn a student's rough lecture notes and the lecture transcript into clear, well-organised study notes.`
      : `You turn someone's rough meeting notes and the meeting transcript into clear, well-organised notes they can share.`,
    ``,
    `How to write the notes:`,
    `- The user's own notes come first. Every point they wrote must appear, close to their wording (fix obvious typos only). Expand each with the relevant detail from the transcript.`,
    v.is_lecture
      ? `- Add the important points from the transcript that the user didn't write down: key concepts and their definitions, formulas, worked examples, names, dates, and any assignments or deadlines.`
      : `- Add the important points from the transcript that the user didn't write down: decisions, numbers, dates, names, commitments, open questions.`,
    `- Only include what was actually said or written. If something in the transcript is unclear, leave it out rather than guess.`,
    `- Be concise: short, specific bullets. No filler, no repetition, no commentary about the meeting itself.`,
    v.is_short_transcript && `- The transcript is very short, so rely mainly on the user's notes and do not pad.`,
    v.has_long_user_notes && `- The user took detailed notes; keep their structure and order.`,
    ``,
    v.is_lecture
      ? v.has_speaker_attribution
        ? `Transcript speakers: the transcript was recorded from ${listener}'s microphone in the room. Voices were told apart automatically: "Speaker 1", "Speaker 2"… (or names) are different people in the room; the one who talks most is most likely the lecturer, others may be audience questions. The labels can occasionally be wrong. The notes were taken by ${listener}, who was mostly listening, so do not attribute what was said to them.`
        : `Transcript speakers: the transcript was recorded from ${listener}'s microphone in the room. "Speaker" is mostly the lecturer and may include questions from the audience; speakers are not separated. The notes were taken by ${listener}, who was mostly listening, so do not attribute what was said to them.`
      : v.has_speaker_attribution
        ? `Transcript speakers: lines marked "(me)" or "Me" are ${v.my_name}, who took these notes. The other speakers${v.their_name ? ` (the attendees: ${v.their_name})` : ''} were told apart automatically and are labelled by name where known, or "Speaker 1", "Speaker 2"… when not identified; "Them" is call audio that could not be separated. Attribute points to people by these labels, but the labels can occasionally be wrong, so don't guess a name for an unidentified speaker.`
        : `Transcript speakers: lines marked "(me)" or "Me" are ${v.my_name}, who took these notes. "Them" is everyone else on the call${v.their_name ? ` (${v.their_name})` : ''}; individual speakers on that side are not separated, so do not attribute quotes to a specific person unless the transcript makes it clear.`,
    v.user_dictionary && `Spell these terms exactly like this: ${v.user_dictionary}.`,
    ``,
    `Structure:`,
    structure,
    ``,
    `Format: Markdown only. Use "### " for headings and "- " for bullets (indent sub-bullets by two spaces). Do not add a title, a preamble or a closing line; start directly with the first heading.`,
    extraInstructions && `\nAdditional instructions from the user: ${extraInstructions}`
  )
}

export function enhanceUserMessage(v: PromptVariables, transcriptOverride?: string, currentNotes?: string): string {
  const tag = v.is_lecture ? 'lecture' : 'meeting'
  return lines(
    `<${tag}>`,
    `Title: ${v.calendar_event_title || `Untitled ${tag}`}`,
    `Date: ${v.date} at ${v.time}`,
    v.participants && `Participants: ${v.participants}`,
    v.template_title && `Meeting type: ${v.template_title}${v.meeting_description ? ` (${v.meeting_description})` : ''}`,
    `</${tag}>`,
    ``,
    `<my_notes>`,
    v.notes.trim() || '(The user did not write any notes.)',
    `</my_notes>`,
    ``,
    `<transcript>`,
    (transcriptOverride ?? v.transcript).trim() || '(No transcript was recorded.)',
    `</transcript>`,
    ``,
    currentNotes?.trim() &&
      lines(
        `<current_notes>`,
        currentNotes.trim(),
        `</current_notes>`,
        ``,
        `These are the current enhanced notes, which the user may have edited. Rewrite them following the additional instructions; keep the user's own edits and additions unless the instructions say otherwise.`,
        ``
      ),
    currentNotes?.trim() ? `Write the rewritten notes now.` : `Write the enhanced notes now.`
  )
}

export function condenseSystemPrompt(lecture: boolean): string {
  return lines(
    `You compress part of a ${lecture ? 'lecture' : 'meeting'} transcript into detailed notes so a later step can write the final summary.`,
    lecture
      ? `Keep every concept, definition, formula, example, number, date, name, question and assignment.`
      : `Keep every decision, number, date, name, commitment, question and disagreement. Keep who said what, using the transcript's speaker labels exactly.`,
    `Write terse bullets with the [mm:ss] timestamp of each point. No introduction or conclusion.`
  )
}

/** "Transcript Summary": what was said about one line of the notes, with supporting quotes. */
export function transcriptSummarySystemPrompt(lecture: boolean): string {
  const event = lecture ? 'lecture' : 'meeting'
  return lines(
    `The user is reading the notes from a ${event} and has picked one line. Explain where that line comes from: what was said in the ${event} that it is based on.`,
    ``,
    `- Write one to three short, plain sentences. Be specific; don't repeat the line back.`,
    `- After the sentence it supports, give each supporting quote on its own line, starting with "> ". Copy the quote word for word from the transcript: never paraphrase, merge or invent quotes. Leave out the [mm:ss] time and the speaker label. Use at most three quotes.`,
    `- No headings, no bullet lists, no preamble.`,
    `- If nothing in the transcript relates to the line, reply with exactly ${NO_CONTEXT} and nothing else.`
  )
}

export function transcriptSummaryUserMessage(v: { title: string; date: string; line: string; transcript: string; lecture: boolean; partial: boolean }): string {
  const tag = v.lecture ? 'lecture' : 'meeting'
  return lines(
    `<${tag}>`,
    `Title: ${v.title || `Untitled ${tag}`}`,
    `Date: ${v.date}`,
    `</${tag}>`,
    ``,
    `<transcript${v.partial ? ' excerpt="true"' : ''}>`,
    v.transcript,
    `</transcript>`,
    v.partial && `(Only the parts of the transcript most related to the line are included.)`,
    ``,
    `<line>`,
    v.line,
    `</line>`
  )
}

export const TITLE_SYSTEM_PROMPT = lines(
  `Write a short, specific title for a meeting note: at most 6 words, no quotes, no trailing punctuation, no date.`,
  `Prefer the main topic or the counterpart's company/name over generic words like "Meeting" or "Sync".`,
  `Reply with the title only.`
)
