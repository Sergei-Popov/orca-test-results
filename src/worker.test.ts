import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('opens a failure source from the selected report and refuses changed or external files', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'test-results-'))
  const root = join(fixture, 'repo')
  const outside = join(fixture, 'outside.xml')
  const reportPath = 'test-results/junit.xml'
  const report = join(root, reportPath)
  await mkdir(join(root, 'test-results'), { recursive: true })
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests/export.test.ts'), '')
  await writeFile(outside, '<testsuites/>')
  await symlink(outside, join(root, 'foreign.xml'), 'file')
  await writeFile(join(root, 'report-content'), '<testsuites/>')
  await symlink('report-content', join(root, 'alias.xml'), 'file')
  await writeFile(report, `<testsuite name="CSV">
    <testcase name="exports current filters" file="tests/export.test.ts" line="12">
      <failure message="unexpected rows"><![CDATA[expected 2; found 3]]></failure>
    </testcase>
    <testcase name="sibling workspace" file="../outside.xml">
      <error message="file not found"/>
    </testcase>
  </testsuite>`)
  const host = mockHost({ results: {
    'workspace.list': { workspaces: [{ id: 'local', name: 'CSV', kind: 'worktree', path: root, branch: 'csv', hostId: 'local' }], truncated: false },
    'editor.open': { opened: true }
  } })
  const worker = await mountWorker(main, { host })
  const selected = { workspaceId: 'local', path: reportPath }
  try {
    const discovered = await worker.request('reports.discover', { workspaceId: 'local' })
    assert.deepEqual(discovered.reports.map(({ path }) => path), [reportPath])
    const loaded = await worker.request('reports.load', selected)
    assert.equal(loaded.failed, 2)
    assert.equal(loaded.failures[0].source, 'tests/export.test.ts')
    assert.equal(loaded.failures[0].line, 12)
    assert.equal(loaded.failures[1].source, undefined)
    const failure = { ...selected, failureKey: loaded.failures[0].key, modifiedAt: loaded.modifiedAt }
    assert.deepEqual(await worker.request('reports.open', failure), { opened: true })
    assert.deepEqual(host.calls.find(({ method }) => method === 'editor.open')?.params,
      { workspaceId: 'local', path: 'tests/export.test.ts' })
    await utimes(report, new Date(2020, 0, 1), new Date(2020, 0, 1))
    await assert.rejects(worker.request('reports.open', failure), /report changed/i)
    await assert.rejects(worker.request('reports.load', { ...selected, path: 'foreign.xml' }), /inside the selected workspace/i)
    const alias = await worker.request('reports.load', { ...selected, path: 'alias.xml' })
    assert.equal(alias.path, 'alias.xml')
    assert.deepEqual(await worker.request('reports.open', { ...selected, path: alias.path }), { opened: true })
  } finally {
    await worker.deactivate()
    await rm(fixture, { recursive: true, force: true })
  }
})

test('considers reports beyond the display limit when ordering by modification time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-results-discovery-'))
  const dir = join(root, 'target/surefire-reports')
  await mkdir(dir, { recursive: true })
  const files = Array.from({ length: 81 }, (_, index) => `TEST-suite-${index}.xml`)
  await Promise.all(files.map(file => writeFile(join(dir, file), '<testsuites/>')))
  const last = (await readdir(dir)).at(-1)!
  const newer = new Date(Date.now() + 60_000)
  await utimes(join(dir, last), newer, newer)
  const host = mockHost({ results: {
    'workspace.list': { workspaces: [{ id: 'local', name: 'CSV', kind: 'worktree', path: root, branch: 'csv', hostId: 'local' }], truncated: false }
  } })
  const worker = await mountWorker(main, { host })
  try {
    const { reports } = await worker.request('reports.discover', { workspaceId: 'local' })
    assert.equal(reports.length, 80)
    assert.equal(reports[0].path, `target/surefire-reports/${last}`)
  } finally {
    await worker.deactivate()
    await rm(root, { recursive: true, force: true })
  }
})
