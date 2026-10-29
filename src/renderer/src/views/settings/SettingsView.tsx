import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  AudioLines,
  Bot,
  BrainCircuit,
  CalendarDays,
  Check,
  CircleAlert,
  Download,
  FileKey,
  FolderOpen,
  Languages,
  MessageSquare,
  Mic,
  Radar,
  Receipt,
  Server,
  SlidersHorizontal,
  Speaker,
  SunMoon,
  Trash2,
  UserRound,
  Volume2,
  WandSparkles
} from 'lucide-react'
import { call, errorMessage, useEvent } from '../../lib/api'
import { navigate, type SettingsSection } from '../../lib/router'
import { useApp } from '../../store'
import { Badge, Button, Input, Select, Spinner, Switch, Textarea, cn } from '../../components/oats'
import { SidebarFrame, SidebarHeader, SidebarItem } from '../../components/shell/Sidebar'
import { Group, Page, Row } from './layout'
import { UsagePage } from './UsagePage'
import type { DeepPartial } from '@shared/ipc'
import { SECRET_ENV_VARS } from '@shared/defaults'
import type { AudioDevice, EnvSecretName, EnvironmentStatus, LlmProviderId, SecretStatus, Settings, WhisperModelInfo } from '@shared/types'

// Settings as Granola lays them out (docs/granola-ui.md §Settings): a settings sidebar replacing the main one,
// and one page per section with grouped cards of rows.

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'Preferences', icon: <SlidersHorizontal size={16} /> },
  { id: 'profile', label: 'Profile', icon: <UserRound size={16} /> },
  { id: 'transcription', label: 'Transcription', icon: <AudioLines size={16} /> },
  { id: 'audio', label: 'Audio', icon: <Mic size={16} /> },
  { id: 'ai', label: 'AI', icon: <BrainCircuit size={16} /> },
  { id: 'assistant', label: 'Assistant', icon: <Bot size={16} /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={16} /> },
  { id: 'usage', label: 'Usage', icon: <Receipt size={16} /> }
]

export function SettingsSidebar({ section }: { section: SettingsSection }): ReactNode {
  return (
    <SidebarFrame>
      <SidebarHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
        <SidebarItem icon={<ArrowLeft size={16} />} label="Back to notes" onClick={() => navigate('/')} className="mb-2" />
        <div className="flex h-7 items-center px-2 text-xs font-medium text-ink-secondary">Settings</div>
        {SECTIONS.map((s) => (
          <SidebarItem key={s.id} icon={s.icon} label={s.label} active={section === s.id} onClick={() => navigate(`/settings/${s.id}`)} testId={`settings-nav-${s.id}`} />
        ))}
      </div>
    </SidebarFrame>
  )
}

function useUpdate(): (patch: DeepPartial<Settings>) => Promise<void> {
  const setSettings = useApp((s) => s.setSettings)
  const showToast = useApp((s) => s.showToast)
  return async (patch) => {
    try {
      setSettings(await call('settings:update', patch))
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }
}

function StatusText({ ok, children }: { ok: boolean; children: ReactNode }): ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', ok ? 'text-ink-success' : 'text-ink-danger')}>
      {ok ? <Check size={14} /> : <CircleAlert size={14} />} {children}
    </span>
  )
}

/** Whether an API key is set in Cereal's .env file. Keys are edited in that file; the app never shows their value. */
function EnvKeyRow({ label, name, status, envFile, hint }: { label: string; name: EnvSecretName; status: SecretStatus | null; envFile?: string; hint?: ReactNode }): ReactNode {
  const showToast = useApp((s) => s.showToast)
  const variable = SECRET_ENV_VARS[name]
  const missing = !!status && !status[name]
  return (
    <Row
      icon={<FileKey size={16} />}
      title={
        <span className="flex items-center gap-2">
          {label} {status && <StatusText ok={!missing}>{missing ? 'Not set' : 'Set'}</StatusText>}
        </span>
      }
      description={
        <>
          <code>{variable}</code> in {envFile ?? 'Cereal’s .env file'}. {hint}
        </>
      }
    >
      <Button size="sm" variant="soft" onClick={() => void call('secrets:open-env').catch((e) => showToast('error', errorMessage(e)))}>
        Open .env
      </Button>
    </Row>
  )
}

function TestRow({ title, run }: { title: string; run: () => Promise<{ ok: boolean; message: string }> }): ReactNode {
  const [state, setState] = useState<{ busy?: boolean; ok?: boolean; message?: string }>({})
  return (
    <Row icon={<Server size={16} />} title={title} description={state.message ? <StatusText ok={!!state.ok}>{state.message}</StatusText> : 'Checks the key and connection.'}>
      <Button
        size="sm"
        variant="soft"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true })
          try {
            setState(await run())
          } catch (e) {
            setState({ ok: false, message: errorMessage(e) })
          }
        }}
      >
        {state.busy && <Spinner className="size-3 border-[1.5px]" />} Test
      </Button>
    </Row>
  )
}

function ModelInput({ provider, value, onChange }: { provider: LlmProviderId; value: string; onChange: (v: string) => void }): ReactNode {
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    void call('llm:models', provider).then(setModels)
  }, [provider])
  return (
    <>
      <Input size="sm" className="w-56" list={`models-${provider}`} defaultValue={value} onBlur={(e) => e.target.value !== value && onChange(e.target.value.trim())} />
      <datalist id={`models-${provider}`}>
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  )
}

function TextSetting({ value, onSave, placeholder, className, type }: { value: string | number; onSave: (v: string) => void; placeholder?: string; className?: string; type?: string }): ReactNode {
  return <Input size="sm" type={type} className={cn('w-56', className)} defaultValue={value} placeholder={placeholder} onBlur={(e) => String(value) !== e.target.value && onSave(e.target.value.trim())} />
}

// ------------------------------------------------------------------ pages

export function SettingsView({ section }: { section: SettingsSection }): ReactNode {
  const settings = useApp((s) => s.settings)
  if (!settings) return null
  switch (section) {
    case 'profile':
      return <ProfilePage settings={settings} />
    case 'transcription':
      return <TranscriptionPage settings={settings} />
    case 'audio':
      return <AudioPage settings={settings} />
    case 'ai':
      return <AiPage settings={settings} />
    case 'assistant':
      return <AssistantPage settings={settings} />
    case 'calendar':
      return <CalendarPage settings={settings} />
    case 'usage':
      return <UsagePage />
    default:
      return <GeneralPage settings={settings} />
  }
}

function GeneralPage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const templates = useApp((s) => s.templates)
  const [env, setEnv] = useState<EnvironmentStatus | null>(null)
  useEffect(() => void call('env:status').then(setEnv), [])
  return (
    <Page title="Preferences">
      <Group label="Appearance">
        <Row icon={<SunMoon size={16} />} title="Theme" description="Match your system, or always use light or dark.">
          <Select
            aria-label="Theme"
            size="sm"
            value={settings.theme}
            onChange={(theme) => void update({ theme })}
            options={[
              { value: 'system', label: 'Match system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        </Row>
      </Group>
      <Group label="Meetings">
        <Row icon={<Radar size={16} />} title="Detect meetings" description="When Zoom, Meet, Teams, Slack or Discord starts using your mic, offer to take notes.">
          <Switch checked={settings.detection.enabled} onChange={(v) => void update({ detection: { enabled: v } })} aria-label="Detect meetings" />
        </Row>
        <Row icon={<WandSparkles size={16} />} title="Enhance notes when transcription stops" description="Writes enhanced notes as soon as a meeting ends.">
          <Switch checked={settings.enhance.autoEnhanceOnStop} onChange={(v) => void update({ enhance: { autoEnhanceOnStop: v } })} aria-label="Enhance automatically" />
        </Row>
        <Row icon={<WandSparkles size={16} />} title="Default template" description="Used for enhanced notes unless a note picks another one.">
          <Select
            aria-label="Default template"
            size="sm"
            value={settings.enhance.defaultTemplate}
            onChange={(defaultTemplate) => void update({ enhance: { defaultTemplate } })}
            options={templates.map((t) => ({ value: t.slug, label: t.title }))}
          />
        </Row>
        <Row icon={<Volume2 size={16} />} title="Sounds" description="Play a sound when transcription starts and stops.">
          <Switch checked={settings.audio.playSounds} onChange={(v) => void update({ audio: { playSounds: v } })} aria-label="Play sounds" />
        </Row>
      </Group>
      {env && !env.safeStorage && <p className="px-2 text-xs text-ink-danger">No system keyring available: your Google Calendar sign-in is stored unencrypted.</p>}
    </Page>
  )
}

function ProfilePage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const p = settings.profile
  return (
    <Page title="Profile" description="Used so enhanced notes know which side of the conversation is you.">
      <Group>
        <Row title="Name">
          <TextSetting value={p.name} onSave={(name) => void update({ profile: { name } })} />
        </Row>
        <Row title="Work email">
          <TextSetting value={p.email} onSave={(email) => void update({ profile: { email } })} />
        </Row>
        <Row title="Company">
          <TextSetting value={p.company} onSave={(company) => void update({ profile: { company } })} />
        </Row>
        <Row title="Job title">
          <TextSetting value={p.jobTitle} onSave={(jobTitle) => void update({ profile: { jobTitle } })} />
        </Row>
      </Group>
    </Page>
  )
}

function TranscriptionPage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const [secrets, setSecrets] = useState<SecretStatus | null>(null)
  const [env, setEnv] = useState<EnvironmentStatus | null>(null)
  const [models, setModels] = useState<WhisperModelInfo[]>([])
  const [dictionary, setDictionary] = useState(settings.dictionary.join(', '))
  const t = settings.transcription
  useEffect(() => {
    void call('secrets:status').then(setSecrets)
    void call('env:status').then(setEnv)
    void call('asr:models').then(setModels)
    const refresh = (): void => void call('secrets:status').then(setSecrets)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  useEvent('asr:models-changed', setModels)

  return (
    <Page title="Transcription" description="Deepgram streams accurate live transcripts from the cloud. Local Whisper runs on this computer with whisper.cpp; nothing leaves your machine.">
      <Group>
        <Row icon={<AudioLines size={16} />} title="Engine">
          <Select
            aria-label="Transcription engine"
            size="sm"
            value={t.engine}
            onChange={(engine) => void update({ transcription: { engine } })}
            options={[
              { value: 'deepgram', label: 'Deepgram (cloud)' },
              { value: 'whisper', label: 'Whisper (local)' }
            ]}
          />
        </Row>
        {t.engine === 'deepgram' ? (
          <>
            <EnvKeyRow label="Deepgram API key" name="deepgramApiKey" status={secrets} envFile={env?.envFile} hint="Create one at console.deepgram.com." />
            <Row title="Model">
              <TextSetting value={t.deepgramModel} onSave={(v) => void update({ transcription: { deepgramModel: v || 'nova-3' } })} />
            </Row>
            <Row icon={<Languages size={16} />} title="Language" description="e.g. en, en-GB, es, or multi for mixed languages.">
              <TextSetting value={t.language} onSave={(v) => void update({ transcription: { language: v || 'en' } })} className="w-32" />
            </Row>
            <TestRow title="Test Deepgram" run={() => call('asr:test-deepgram')} />
          </>
        ) : (
          <>
            <Row
              icon={<Server size={16} />}
              title="whisper-server"
              description={env?.whisperServer ? <StatusText ok>Found: {env.whisperServer}</StatusText> : <StatusText ok={false}>Not found. Install whisper.cpp (sudo dnf install whisper-cpp) or set the path.</StatusText>}
            >
              <TextSetting
                value={t.whisperServerPath}
                placeholder="Auto-detect from PATH"
                onSave={async (v) => {
                  await update({ transcription: { whisperServerPath: v } })
                  setEnv(await call('env:status'))
                }}
              />
            </Row>
            <Row title="CPU threads">
              <TextSetting type="number" className="w-20" value={t.whisperThreads} onSave={(v) => void update({ transcription: { whisperThreads: Math.max(1, Number(v) || 4) } })} />
            </Row>
          </>
        )}
      </Group>
      {t.engine === 'whisper' && (
        <Group label="Whisper model">
          {models.map((m) => (
            <Row
              key={m.id}
              title={
                <span className="flex items-center gap-2">
                  {m.label} {t.whisperModel === m.id && <Badge variant="accent">In use</Badge>}
                </span>
              }
              description={`${m.sizeMb} MB${m.downloaded ? ' · downloaded' : ''}`}
            >
              {m.downloading ? (
                <span className="text-xs text-ink-secondary tabular-nums">{Math.round(m.progress * 100)}%</span>
              ) : m.downloaded ? (
                <>
                  {t.whisperModel !== m.id && (
                    <Button size="sm" variant="soft" onClick={() => void update({ transcription: { whisperModel: m.id } })}>
                      Use
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" aria-label="Delete model" onClick={() => void call('asr:delete', m.id)}>
                    <Trash2 size={14} />
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="soft" onClick={() => void call('asr:download', m.id).then(() => update({ transcription: { whisperModel: m.id } }))}>
                  <Download size={14} /> Download
                </Button>
              )}
            </Row>
          ))}
        </Group>
      )}
      <Group label="Vocabulary">
        <Row stacked title="Custom vocabulary" description="Names, products and jargon to spell correctly, separated by commas. Also passed to the AI.">
          <Input size="sm" value={dictionary} onChange={(e) => setDictionary(e.target.value)} onBlur={() => void update({ dictionary: dictionary.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </Row>
      </Group>
    </Page>
  )
}

const DEFAULT_DEVICE = '@default'

function AudioPage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [env, setEnv] = useState<EnvironmentStatus | null>(null)
  useEffect(() => {
    void call('audio:devices').then(setDevices)
    void call('env:status').then(setEnv)
  }, [])
  const options = (kind: 'source' | 'sink'): { value: string; label: string }[] => [
    { value: DEFAULT_DEVICE, label: 'System default' },
    ...devices.filter((d) => d.kind === kind).map((d) => ({ value: d.name, label: `${d.description}${d.isDefault ? ' (default)' : ''}` }))
  ]
  return (
    <Page
      title="Audio"
      description="Cereal records your microphone (“You”) and what your speakers play (“Them”) through PipeWire. No bot joins your call. Use headphones to keep the two sides separate. For a lecture or talk in the room, switch the note to Lecture mode to record only your mic."
    >
      {env && !env.pwRecord && <p className="mb-4 px-2 text-xs text-ink-danger">pw-record was not found. Install pipewire-utils.</p>}
      <Group>
        <Row icon={<Speaker size={16} />} title="Capture system audio" description="The other side of calls.">
          <Switch checked={settings.audio.captureSystem} onChange={(v) => void update({ audio: { captureSystem: v } })} aria-label="Capture system audio" />
        </Row>
        <Row icon={<Mic size={16} />} title="Microphone">
          <Select aria-label="Microphone" size="sm" className="max-w-64" value={settings.audio.micTarget ?? DEFAULT_DEVICE} onChange={(v) => void update({ audio: { micTarget: v === DEFAULT_DEVICE ? null : v } })} options={options('source')} />
        </Row>
        <Row icon={<Volume2 size={16} />} title="Speakers to capture">
          <Select aria-label="Speakers to capture" size="sm" className="max-w-64" value={settings.audio.systemTarget ?? DEFAULT_DEVICE} onChange={(v) => void update({ audio: { systemTarget: v === DEFAULT_DEVICE ? null : v } })} options={options('sink')} />
        </Row>
      </Group>
    </Page>
  )
}

function AiPage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const [secrets, setSecrets] = useState<SecretStatus | null>(null)
  const [env, setEnv] = useState<EnvironmentStatus | null>(null)
  const llm = settings.llm
  useEffect(() => {
    void call('secrets:status').then(setSecrets)
    void call('env:status').then(setEnv)
    const refresh = (): void => void call('secrets:status').then(setSecrets)
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  return (
    <Page
      title="AI"
      description="Writes enhanced notes and titles, answers chat and runs the Assistant. Use Claude, OpenAI or Gemini with your own API key, or a local model through Ollama (chat and the Assistant need one that can use tools). The chat bar's model picker can switch any chat to another configured model; Auto uses the provider below."
    >
      <Group>
        <Row icon={<BrainCircuit size={16} />} title="Provider">
          <Select
            aria-label="AI provider"
            size="sm"
            value={llm.provider}
            onChange={(provider) => void update({ llm: { provider } })}
            options={[
              { value: 'anthropic', label: 'Claude' },
              { value: 'openai', label: 'OpenAI' },
              { value: 'gemini', label: 'Google Gemini' },
              { value: 'ollama', label: 'Ollama (local)' }
            ]}
          />
        </Row>
        {llm.provider === 'anthropic' && (
          <>
            <EnvKeyRow label="Anthropic API key" name="anthropicApiKey" status={secrets} envFile={env?.envFile} hint="Create one at console.anthropic.com." />
            <Row title="Notes & chat model">
              <ModelInput provider="anthropic" value={llm.anthropicModel} onChange={(v) => void update({ llm: { anthropicModel: v } })} />
            </Row>
            <Row title="Fast model" description="Titles and small jobs.">
              <ModelInput provider="anthropic" value={llm.anthropicFastModel} onChange={(v) => void update({ llm: { anthropicFastModel: v } })} />
            </Row>
          </>
        )}
        {llm.provider === 'openai' && (
          <>
            <EnvKeyRow label="OpenAI API key" name="openaiApiKey" status={secrets} envFile={env?.envFile} />
            <Row title="Notes & chat model">
              <ModelInput provider="openai" value={llm.openaiModel} onChange={(v) => void update({ llm: { openaiModel: v } })} />
            </Row>
            <Row title="Fast model" description="Titles and small jobs.">
              <ModelInput provider="openai" value={llm.openaiFastModel} onChange={(v) => void update({ llm: { openaiFastModel: v } })} />
            </Row>
          </>
        )}
        {llm.provider === 'gemini' && (
          <>
            <EnvKeyRow label="Gemini API key" name="geminiApiKey" status={secrets} envFile={env?.envFile} hint="Create one at aistudio.google.com." />
            <Row title="Notes & chat model">
              <ModelInput provider="gemini" value={llm.geminiModel} onChange={(v) => void update({ llm: { geminiModel: v } })} />
            </Row>
            <Row title="Fast model" description="Titles and small jobs.">
              <ModelInput provider="gemini" value={llm.geminiFastModel} onChange={(v) => void update({ llm: { geminiFastModel: v } })} />
            </Row>
          </>
        )}
        {llm.provider === 'ollama' && (
          <>
            <Row title="Ollama URL">
              <TextSetting value={llm.ollamaUrl} onSave={(v) => void update({ llm: { ollamaUrl: v || 'http://127.0.0.1:11434' } })} />
            </Row>
            <Row title="Model" description="Pull it first, e.g. ollama pull llama3.1">
              <ModelInput provider="ollama" value={llm.ollamaModel} onChange={(v) => void update({ llm: { ollamaModel: v } })} />
            </Row>
          </>
        )}
        <TestRow title="Test connection" run={() => call('llm:test', llm.provider)} />
      </Group>
      <Group>
        <Row icon={<MessageSquare size={16} />} title="Chat Enter key behavior" description="What Enter does in the chat bar.">
          <Select
            aria-label="Chat Enter key behavior"
            size="sm"
            value={settings.chat.enterKey}
            onChange={(enterKey) => void update({ chat: { enterKey } })}
            options={[
              { value: 'send', label: 'Send message' },
              { value: 'newline', label: 'New line (Ctrl ↵ to send)' }
            ]}
          />
        </Row>
      </Group>
    </Page>
  )
}

function AssistantPage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const showToast = useApp((s) => s.showToast)
  const a = settings.assistant
  return (
    <Page
      title="Assistant"
      description="A personal agent that works through tasks in the background with your notes, transcripts and calendar, keeps a memory of what matters to you and runs routines on a schedule. It uses your AI provider."
    >
      <Group>
        <Row icon={<Bot size={16} />} title="Run the Assistant" description="Tasks, routines and memory.">
          <Switch checked={a.enabled} onChange={(enabled) => void update({ assistant: { enabled } })} aria-label="Run the Assistant" />
        </Row>
        <Row stacked title="Standing instructions" description="Added to everything the Assistant does.">
          <Textarea
            rows={3}
            size="sm"
            defaultValue={a.instructions}
            placeholder="e.g. Keep emails short and informal. I work UK hours. Always cc my assistant Sam on follow-ups."
            onBlur={(e) => void update({ assistant: { instructions: e.target.value } })}
          />
        </Row>
        <Row
          stacked
          title="Always allowed"
          description={a.alwaysAllow.length === 0 ? 'Nothing yet. Actions that change things outside the Assistant’s memory ask first; choose “Always allow” on one to stop asking.' : 'These actions run without asking. Remove one to be asked again.'}
        >
          {a.alwaysAllow.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {a.alwaysAllow.map((t) => (
                <span key={t} className="inline-flex h-7 items-center gap-1 rounded-full bg-fill-soft pr-1 pl-2.5 font-mono text-xs">
                  {t}
                  <button type="button" aria-label="Ask again" onClick={() => void update({ assistant: { alwaysAllow: a.alwaysAllow.filter((x) => x !== t) } })} className="flex size-5 cursor-default items-center justify-center rounded-full text-ink-tertiary hover:text-ink-primary">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </Row>
        <Row icon={<FolderOpen size={16} />} title="The Assistant’s folder" description="Its memory, skills and files.">
          <Button size="sm" variant="soft" onClick={() => void call('assistant:open-folder').catch((e) => showToast('error', errorMessage(e)))}>
            Open folder
          </Button>
        </Row>
      </Group>
    </Page>
  )
}

function CalendarPage({ settings }: { settings: Settings }): ReactNode {
  const update = useUpdate()
  const setSettings = useApp((s) => s.setSettings)
  const showToast = useApp((s) => s.showToast)
  const [secrets, setSecrets] = useState<SecretStatus | null>(null)
  const [env, setEnv] = useState<EnvironmentStatus | null>(null)
  useEffect(() => {
    void call('secrets:status').then(setSecrets)
    void call('env:status').then(setEnv)
  }, [])
  const c = settings.calendar
  return (
    <Page
      title="Calendar"
      description={
        <>
          Shows upcoming meetings and reminds you to take notes. Cereal has no server, so it uses your own OAuth client: in Google Cloud Console create an OAuth client of type <b className="font-medium">Desktop app</b>, enable the Google
          Calendar API, paste its ID here, and put its secret in Cereal’s .env file.
        </>
      }
    >
      <Group label="Google Calendar">
        <Row icon={<CalendarDays size={16} />} title="Google Calendar" description={c.connected ? <StatusText ok>Connected</StatusText> : 'Not connected'}>
          {c.connected ? (
            <>
              <Button size="sm" variant="soft" onClick={() => void call('calendar:sync').then(() => showToast('info', 'Calendar synced'))}>
                Sync now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await call('calendar:disconnect')
                  setSettings(await call('settings:get'))
                }}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={!c.googleClientId}
              onClick={async () => {
                const res = await call('calendar:connect')
                showToast(res.ok ? 'info' : 'error', res.message)
                setSettings(await call('settings:get'))
              }}
            >
              Connect
            </Button>
          )}
        </Row>
        <Row title="OAuth client ID">
          <TextSetting value={c.googleClientId} placeholder="…apps.googleusercontent.com" className="w-72" onSave={(v) => void update({ calendar: { googleClientId: v } })} />
        </Row>
        <EnvKeyRow label="OAuth client secret" name="googleClientSecret" status={secrets} envFile={env?.envFile} />
        <Row title="Remind me before meetings" description="Minutes before a meeting starts.">
          <TextSetting type="number" className="w-20" value={c.notifyMinutesBefore} onSave={(v) => void update({ calendar: { notifyMinutesBefore: Math.max(0, Number(v) || 0) } })} />
        </Row>
      </Group>
    </Page>
  )
}
