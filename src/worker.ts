import { open, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { parseJUnit } from './junit'
import type { TestReport } from './protocol'

const reportLimit = 8 * 1024 * 1024
const reportPaths = [
  'junit.xml', 'test-results.xml', 'junit-report.xml', 'test-results/junit.xml',
  '.test-results/junit.xml', 'reports/junit.xml', 'target/nextest/default/junit.xml'
]
const reportDirectories = ['target/surefire-reports', 'target/failsafe-reports', 'build/test-results/test']

async function workspaces(orca: OrcaWorkerApi) {
  const { workspaces } = await orca.host.call('workspace.list')
  return workspaces.filter(({ hostId, path }) => (hostId === 'local' || hostId === null) && isAbsolute(path))
}

async function workspaceRoot(orca: OrcaWorkerApi, workspaceId: string): Promise<string> {
  const space = (await workspaces(orca)).find(({ id }) => id === workspaceId)
  if (!space) throw new Error('The selected local workspace is unavailable.')
  return realpath(space.path)
}

function outside(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

async function workspacePath(root: string, candidate: string): Promise<string> {
  if (outside(root, candidate)) throw new Error('The path must be inside the selected workspace.')
  const canonical = await realpath(candidate)
  if (outside(root, canonical)) throw new Error('The path must be inside the selected workspace.')
  return canonical
}

function relativePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

async function reportFile(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || extname(path).toLowerCase() !== '.xml') {
    throw new Error('Enter a relative path to a JUnit XML report.')
  }
  return workspacePath(root, resolve(root, path))
}

async function sourceFile(root: string, report: string, path: string): Promise<string | undefined> {
  for (const candidate of new Set([resolve(root, path), resolve(dirname(report), path)])) {
    const file = await workspacePath(root, candidate).catch(() => undefined)
    if (file && (await stat(file).catch(() => undefined))?.isFile()) return file
  }
}

async function discover(root: string) {
  const candidates = new Set(reportPaths)
  for (const dir of reportDirectories) {
    const folder = await workspacePath(root, join(root, dir)).catch(() => undefined)
    if (!folder) continue
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && /^TEST-.+\.xml$/i.test(entry.name)) candidates.add(`${dir}/${entry.name}`)
    }
  }
  const paths = [...candidates]
  const reports: { path: string; modifiedAt: number }[] = []
  const concurrency = 32
  for (let offset = 0; offset < paths.length; offset += concurrency) {
    const batch = await Promise.all(paths.slice(offset, offset + concurrency).map(async path => {
      const file = await reportFile(root, path).catch(() => undefined)
      const info = file && await stat(file).catch(() => undefined)
      return info && info.isFile() ? { path, modifiedAt: info.mtimeMs } : undefined
    }))
    reports.push(...batch.filter(report => report !== undefined))
  }
  return reports.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path)).slice(0, 80)
}

async function load(root: string, path: string): Promise<TestReport> {
  const file = await reportFile(root, path)
  const info = await stat(file)
  if (!info.isFile()) throw new Error('The report path must be a file.')
  const handle = await open(file)
  try {
    if (info.size > reportLimit) throw new Error('The JUnit report exceeds the 8 MiB size limit.')
    const buffer = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0)
    const after = await handle.stat()
    if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error('The report changed while it was being read. Load it again.')
    }
    const parsed = parseJUnit(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
    const failures = await Promise.all(parsed.failures.map(async failure => {
      const source = failure.file && await sourceFile(root, file, failure.file)
      return { ...failure, ...(source ? { source: relativePath(root, source) } : {}) }
    }))
    return { ...parsed, failures, path: relativePath(root, resolve(root, path)), modifiedAt: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('reports.workspaces', async () => {
    const [rows, focused] = await Promise.all([
      workspaces(orca),
      orca.host.call('workspace.readContext')
    ])
    const matches = focused
      ? rows.filter(row => row.name === focused.displayName && (row.branch ?? '') === focused.branch)
      : rows
    return {
      workspaces: rows.map(({ id, name, project, branch }) => ({ id, name, project: project ?? null, branch })),
      suggestedId: matches.length === 1 ? matches[0].id : null
    }
  })

  orca.panels.handle('reports.discover', async ({ workspaceId }) =>
    ({ reports: await discover(await workspaceRoot(orca, workspaceId)) }))

  orca.panels.handle('reports.load', async ({ workspaceId, path }) =>
    load(await workspaceRoot(orca, workspaceId), path))

  orca.panels.handle('reports.open', async ({ workspaceId, path, failureKey, modifiedAt }) => {
    const root = await workspaceRoot(orca, workspaceId)
    if (failureKey) {
      const report = await load(root, path)
      if (report.modifiedAt !== modifiedAt) throw new Error('The report changed. Load it again before opening a test source.')
      const source = report.failures.find(({ key }) => key === failureKey)?.source
      if (!source) throw new Error('The source file is unavailable in the selected workspace.')
      return orca.host.call('editor.open', { workspaceId, path: source })
    }
    const file = await reportFile(root, path)
    if (!(await stat(file)).isFile()) throw new Error('The report path must be a file.')
    return orca.host.call('editor.open', { workspaceId, path: relativePath(root, file) })
  })
}
