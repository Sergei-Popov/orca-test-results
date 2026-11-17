import {
  atom,
  Badge,
  Button,
  Callout,
  CodeView,
  EmptyState,
  env,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import type { ReportFailure, ReportOption, TestReport, Workspace } from './protocol'

const en = {
  title: 'Test Results',
  workspace: 'Workspace',
  chooseWorkspace: 'Select a workspace',
  noWorkspace: 'No available workspaces',
  refresh: 'Refresh',
  workspacesLoading: 'Loading workspaces',
  reportsLoading: 'Looking for reports',
  reportLoading: 'Loading the report',
  discovered: 'Discovered reports',
  chooseReport: 'Select a report',
  reportPath: 'JUnit report path',
  load: 'Load',
  noReports: 'Enter a report path relative to the workspace.',
  report: 'Report',
  openReport: 'Open report',
  openSource: 'Open source',
  noFailures: 'No failures in this report',
  failuresUnavailable: 'The report gives failure counts without individual failures.',
  failures: 'Failures',
  showMore: 'Show more failures',
  omitted: (count: number) => `${count} additional failures omitted from the list`,
  tests: 'Tests',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
  failure: 'Failure',
  error: 'Error',
  source: 'Source',
  output: 'Test output',
  rerun: 'Rerun command (optional)',
  prepare: 'Prepare for agent',
  draft: 'Agent handoff',
  copy: 'Select the text below and press Ctrl+C or ⌘C to copy.',
  investigate: 'Investigate this failing test in the selected workspace.',
  test: 'Test',
  reportDate: 'Report modified',
  errorTitle: 'Could not complete the request',
  openFailed: 'Orca could not open this file.'
}
const ru: typeof en = {
  title: 'Результаты тестов',
  workspace: 'Рабочая область',
  chooseWorkspace: 'Выберите рабочую область',
  noWorkspace: 'Нет доступных рабочих областей',
  refresh: 'Обновить',
  workspacesLoading: 'Загрузка рабочих областей',
  reportsLoading: 'Поиск отчётов',
  reportLoading: 'Загрузка отчёта',
  discovered: 'Найденные отчёты',
  chooseReport: 'Выберите отчёт',
  reportPath: 'Путь к отчёту JUnit',
  load: 'Загрузить',
  noReports: 'Укажите путь к отчёту относительно рабочей области.',
  report: 'Отчёт',
  openReport: 'Открыть отчёт',
  openSource: 'Открыть исходник',
  noFailures: 'В этом отчёте нет упавших тестов',
  failuresUnavailable: 'В отчёте есть счётчик ошибок, но нет сведений об упавших тестах.',
  failures: 'Упавшие тесты',
  showMore: 'Показать ещё',
  omitted: (count) => `Ошибок за пределами списка — ${count}`,
  tests: 'Всего',
  passed: 'Прошли',
  failed: 'Упали',
  skipped: 'Пропущены',
  failure: 'Сбой',
  error: 'Ошибка',
  source: 'Исходник',
  output: 'Вывод теста',
  rerun: 'Команда повторного запуска (необязательно)',
  prepare: 'Подготовить для агента',
  draft: 'Контекст для агента',
  copy: 'Выделите текст ниже и нажмите Ctrl+C или ⌘C.',
  investigate: 'Разберите падение этого теста в выбранной рабочей области.',
  test: 'Тест',
  reportDate: 'Дата изменения отчёта',
  errorTitle: 'Не удалось выполнить запрос',
  openFailed: 'Orca не смогла открыть файл.'
}
type Copy = typeof en

const PAGE_SIZE = 50
const DRAFT_LIMIT = 12_000
const OUTPUT_LIMIT = 7_000

type Loading = 'workspaces' | 'reports' | 'report'
interface State {
  workspaces: Workspace[]
  workspaceId: string
  options: ReportOption[]
  path: string
  report: TestReport | null
  failureKey: string
  visibleFailures: number
  rerun: string
  draft: string | null
  loading: Loading | null
  opening: boolean
  error: string | null
}
interface Run {
  lookup?: AbortController
  open?: AbortController
  focused?: string | null
}

const clearedReport = {
  report: null,
  failureKey: '',
  visibleFailures: PAGE_SIZE,
  rerun: '',
  draft: null
}
const state = atom<State>({
  workspaces: [],
  workspaceId: '',
  options: [],
  path: '',
  ...clearedReport,
  loading: 'workspaces',
  opening: false,
  error: null
})
const run = atom<Run | null>(null)

function patch(fields: Partial<State>): void {
  update(state, (previous) => ({ ...previous, ...fields }))
}

function strings(): Copy {
  return env.locale.toLowerCase().split('-')[0] === 'ru' ? ru : en
}

function startLookup(current: Run, loading: Loading, fields: Partial<State>): AbortSignal {
  current.lookup?.abort()
  current.open?.abort()
  current.lookup = new AbortController()
  patch({ ...clearedReport, ...fields, loading, opening: false, error: null })
  return current.lookup.signal
}

function showError(error: unknown, signal: AbortSignal): void {
  if (!signal.aborted) {
    patch({ error: error instanceof Error ? error.message : String(error), loading: null, opening: false })
  }
}

async function refresh(preferFocus = false): Promise<void> {
  const current = read(run)
  if (!current) return
  const { workspaceId, path, report } = read(state)
  const signal = startLookup(current, 'workspaces', {})
  try {
    const { workspaces, suggestedId } = await plugin.request('reports.workspaces', undefined, { signal })
    if (signal.aborted) return
    const preserved = workspaces.some((workspace) => workspace.id === workspaceId) ? workspaceId : ''
    const suggested = workspaces.find((workspace) => workspace.id === suggestedId)?.id ?? ''
    const fallback = workspaces.length === 1 ? workspaces[0].id : ''
    const target = (preferFocus ? suggested : preserved || suggested) || fallback
    const existingPath = target === workspaceId ? path : ''
    patch({ workspaces, workspaceId: target, path: existingPath, options: [], loading: target ? 'reports' : null })
    if (target) await discover(target, existingPath, target === workspaceId ? report?.path : undefined, signal)
  } catch (error) {
    showError(error, signal)
  }
}

async function discover(workspaceId: string, path: string, loadedPath: string | undefined, signal: AbortSignal) {
  const { reports } = await plugin.request('reports.discover', { workspaceId }, { signal })
  if (signal.aborted) return
  const suggested = reports[0]?.path ?? ''
  const chosen = path || suggested
  patch({ options: reports, path: chosen, loading: null })
  if (chosen && (!path || (loadedPath && chosen === loadedPath))) {
    await fetchReport(workspaceId, chosen, signal)
  }
}

async function selectWorkspace(workspaceId: string): Promise<void> {
  const current = read(run)
  if (!current || !workspaceId || workspaceId === read(state).workspaceId) return
  const signal = startLookup(current, 'reports', { workspaceId, path: '', options: [] })
  try {
    await discover(workspaceId, '', undefined, signal)
  } catch (error) {
    showError(error, signal)
  }
}

async function fetchReport(workspaceId: string, path: string, signal: AbortSignal): Promise<void> {
  patch({ loading: 'report' })
  const report = await plugin.request('reports.load', { workspaceId, path }, { signal })
  if (!signal.aborted) {
    patch({ path: report.path, report, failureKey: report.failures[0]?.key ?? '', loading: null })
  }
}

async function load(path: string): Promise<void> {
  const current = read(run)
  const workspaceId = read(state).workspaceId
  if (!current || !workspaceId || !path.trim()) return
  const signal = startLookup(current, 'report', { path: path.trim() })
  try {
    await fetchReport(workspaceId, path.trim(), signal)
  } catch (error) {
    showError(error, signal)
  }
}

function editPath(path: string): void {
  const current = read(run)
  if (!current || path === read(state).path) return
  current.lookup?.abort()
  current.open?.abort()
  patch({ ...clearedReport, path, loading: null, opening: false, error: null })
}

function selectFailure(key: string): void {
  if (key !== read(state).failureKey) {
    read(run)?.open?.abort()
    patch({ failureKey: key, rerun: '', draft: null, opening: false, error: null })
  }
}

async function openFile(failureKey?: string): Promise<void> {
  const current = read(run)
  const { workspaceId, report, opening, loading } = read(state)
  if (!current || !report || opening || loading) return
  current.open = new AbortController()
  const { signal } = current.open
  patch({ opening: true, error: null })
  try {
    const input = {
      workspaceId,
      path: report.path,
      ...(failureKey ? { failureKey, modifiedAt: report.modifiedAt } : {})
    }
    const { opened } = await plugin.request('reports.open', input, { signal })
    if (!signal.aborted && !opened) patch({ error: strings().openFailed })
  } catch (error) {
    showError(error, signal)
  } finally {
    if (!signal.aborted) patch({ opening: false })
  }
}

export function setup(ctx: PanelContext): () => void {
  const current: Run = {}
  set(run, current)
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const previous = current.focused
      current.focused = context ? JSON.stringify([context.displayName, context.branch]) : null
      if (previous === undefined || previous === current.focused) return
      const { workspaceId, workspaces } = read(state)
      const selected = workspaces.find((workspace) => workspace.id === workspaceId)
      if (context && selected?.name === context.displayName && (selected.branch ?? '') === context.branch) return
      void refresh(true)
    })
  )
  void refresh()
  return () => {
    current.lookup?.abort()
    current.open?.abort()
  }
}

function workspaceLabel({ project, name, branch }: Workspace): string {
  const parts = project && project !== name ? [project, name] : [name]
  if (branch && branch !== name) parts.push(branch)
  return parts.join(' · ')
}

function reportDate(timestamp: number): string {
  return new Intl.DateTimeFormat(env.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function failureSource(failure: ReportFailure): string {
  const file = failure.source ?? failure.file
  return file ? (failure.line ? `${file}:${failure.line}` : file) : ''
}

function testName(failure: ReportFailure): string {
  return [failure.className, failure.name].filter(Boolean).join(' · ')
}

function clip(value: string, limit = OUTPUT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function prepareDraft(): void {
  const { report, failureKey, rerun, workspaceId, workspaces } = read(state)
  const failure = report?.failures.find((entry) => entry.key === failureKey)
  if (!report || !failure) return
  const t = strings()
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  const source = failureSource(failure)
  const facts = [
    t.investigate,
    '',
    ...(workspace ? [`- ${t.workspace} — ${workspaceLabel(workspace)}`] : []),
    `- ${t.report} — ${report.path}`,
    `- ${t.reportDate} — ${reportDate(report.modifiedAt)}`,
    `- ${t.test} — ${testName(failure)}`,
    ...(failure.suite ? [`- ${failure.suite}`] : []),
    ...(source ? [`- ${t.source} — ${source}`] : []),
    ...(rerun.trim() ? [`- ${t.rerun} — ${rerun.trim()}`] : []),
    ...(failure.message ? ['', t[failure.outcome], clip(failure.message, 2000)] : []),
    ...(failure.output ? ['', t.output, clip(failure.output)] : [])
  ]
  patch({ draft: clip(facts.join('\n'), DRAFT_LIMIT) })
}

function FailureDetail({ failure, t, opening, rerun, draft }: {
  failure: ReportFailure
  t: Copy
  opening: boolean
  rerun: string
  draft: string | null
}) {
  const source = failureSource(failure)
  return (
    <Stack gap="sm">
      <Heading level={3}>{testName(failure)}</Heading>
      {failure.suite && failure.suite !== failure.className ? <Text muted size="xs">{failure.suite}</Text> : null}
      {source ? <Text size="sm">{source}</Text> : null}
      {failure.source ? (
        <Button variant="ghost" size="sm" icon="file-text" disabled={opening} onPress={() => openFile(failure.key)}>
          {t.openSource}
        </Button>
      ) : null}
      {failure.message ? <Text>{clip(failure.message, 2000)}</Text> : null}
      {failure.output ? <CodeView code={clip(failure.output)} label={t.output} wrap maxHeight="sm" /> : null}
      <Input label={t.rerun} value={rerun} maxLength={2000} onChange={(value) => patch({ rerun: value, draft: null })} />
      <Button tone="accent" size="sm" icon="bot" onPress={prepareDraft}>{t.prepare}</Button>
      {draft !== null ? (
        <Stack gap="xs">
          <Text muted size="xs">{t.copy}</Text>
          <Textarea label={t.draft} value={draft} rows={8} maxLength={DRAFT_LIMIT} onChange={(value) => patch({ draft: value })} />
        </Stack>
      ) : null}
    </Stack>
  )
}

function Results({ value, report, t }: { value: State; report: TestReport; t: Copy }) {
  const { failureKey, visibleFailures, opening, rerun, draft } = value
  const failure = report.failures.find((entry) => entry.key === failureKey)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading level={2}>{t.report}</Heading>
        <Text size="sm">{report.path}</Text>
        <Text size="xs" muted>{t.reportDate} · {reportDate(report.modifiedAt)}</Text>
        <Row gap="xs" wrap>
          <Badge>{t.tests} {report.tests}</Badge>
          <Badge tone="success">{t.passed} {report.passed}</Badge>
          <Badge tone={report.failed ? 'danger' : 'neutral'}>{t.failed} {report.failed}</Badge>
          <Badge>{t.skipped} {report.skipped}</Badge>
        </Row>
        <Button variant="ghost" size="sm" icon="file-text" disabled={opening} onPress={() => openFile()}>
          {t.openReport}
        </Button>
      </Stack>
      {report.failures.length > 0 ? (
        <Stack gap="sm">
          <Heading level={2}>{t.failures}</Heading>
          <List label={t.failures}>
            {report.failures.slice(0, visibleFailures).map((entry) => (
              <ListItem
                key={entry.key}
                title={clip(entry.name, 1000)}
                description={clip(entry.className || entry.suite, 1000)}
                icon={entry.outcome === 'error' ? 'error' : 'warning'}
                current={entry.key === failureKey}
                onPress={() => selectFailure(entry.key)}
              />
            ))}
          </List>
          {visibleFailures < report.failures.length ? (
            <Button variant="ghost" size="sm" onPress={() => patch({ visibleFailures: visibleFailures + PAGE_SIZE })}>
              {t.showMore}
            </Button>
          ) : null}
          {report.omittedFailures ? <Text muted size="xs">{t.omitted(report.omittedFailures)}</Text> : null}
        </Stack>
      ) : (
        <EmptyState
          title={report.failed ? t.failures : t.noFailures}
          description={report.failed ? t.failuresUnavailable : undefined}
          icon={report.failed ? 'warning' : 'check'}
        />
      )}
      {failure ? <FailureDetail failure={failure} t={t} opening={opening} rerun={rerun} draft={draft} /> : null}
    </Stack>
  )
}

export default function Panel() {
  const value = read(state)
  const t = strings()
  const { workspaces, workspaceId, options, path, loading, report, error } = value
  const loadingText = loading === 'workspaces' ? t.workspacesLoading : loading === 'reports' ? t.reportsLoading : t.reportLoading
  return (
    <Stack gap="md">
      <Row align="center" justify="between">
        <Heading>{t.title}</Heading>
        <IconButton icon="refresh" label={t.refresh} variant="ghost" onPress={() => refresh()} />
      </Row>
      {workspaces.length ? (
        <Select label={t.workspace} value={workspaceId} placeholder={t.chooseWorkspace} disabled={loading === 'workspaces'}
          options={workspaces.map((workspace) => ({ value: workspace.id, label: workspaceLabel(workspace) }))}
          onChange={selectWorkspace} />
      ) : null}
      {!workspaces.length && !loading && !error ? <EmptyState title={t.noWorkspace} icon="folder" /> : null}
      {workspaceId ? (
        <Stack gap="xs">
          {options.length ? (
            <Select label={t.discovered} value={options.some((option) => option.path === path) ? path : ''}
              placeholder={t.chooseReport} disabled={loading === 'workspaces'}
              options={options.map((option) => ({ value: option.path, label: clip(option.path, 1000) }))}
              onChange={load} />
          ) : null}
          <Input label={t.reportPath} value={path} maxLength={1500}
            disabled={loading === 'workspaces' || loading === 'reports'}
            onChange={editPath} onSubmit={load} />
          <Button variant="outline" size="sm" icon="open-external" disabled={!path.trim() || loading !== null}
            onPress={() => load(path)}>{t.load}</Button>
          {!options.length && !loading && !report ? <Text muted size="xs">{t.noReports}</Text> : null}
        </Stack>
      ) : null}
      {loading ? <Spinner label={loadingText} /> : null}
      {error ? <Callout tone="danger" title={t.errorTitle}><Text>{clip(error, 3000)}</Text></Callout> : null}
      {report ? <Results value={value} report={report} t={t} /> : null}
    </Stack>
  )
}
