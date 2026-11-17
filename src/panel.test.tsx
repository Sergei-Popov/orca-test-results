import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { TestReport, Workspace } from './protocol'

const capabilities = ['workspace:read']
const workspace: Workspace = { id: 'ws-1', name: 'Settings', project: 'Example App', branch: 'feature/settings' }
const report: TestReport = {
  path: 'test-results/junit.xml',
  modifiedAt: Date.UTC(2026, 10, 18, 7, 20),
  tests: 3, passed: 1, failed: 1, skipped: 1, omittedFailures: 0,
  failures: [{
    key: 'failure-1',
    name: 'saves settings',
    className: 'Settings tests',
    suite: 'Web app',
    outcome: 'failure',
    message: 'Expected 5, got 4',
    output: 'Trace summary\n' + 'a'.repeat(7100),
    source: 'src/settings.test.ts',
    line: 15
  }]
}
const passing: TestReport = {
  ...report,
  path: 'reports/passing.xml',
  tests: 3, passed: 3, failed: 0, skipped: 0,
  failures: []
}
const reportOptions = [report, passing].map(({ path, modifiedAt }) => ({ path, modifiedAt }))

test('retries a failed load on refresh and leaves an unsubmitted path alone', async () => {
  const calls: string[] = []
  const view = await mount(panel, { host: mockHost({
    capabilities,
    requests: {
      'reports.workspaces': () => ({ workspaces: [workspace], suggestedId: workspace.id }),
      'reports.discover': () => ({ reports: reportOptions }),
      'reports.load': ({ path }) => {
        calls.push(path)
        if (calls.length === 1) throw new Error('Incomplete XML')
        return report
      }
    }
  }) })
  try {
    assert.ok(view.find({ text: 'Incomplete XML' }))
    await view.press({ label: 'Refresh' })
    assert.ok(view.find({ text: 'Failed 1' }))
    await view.type({ label: 'JUnit report path' }, 'local/unsubmitted.xml', { replace: true })
    await view.press({ label: 'Refresh' })
    assert.deepEqual(calls, [report.path, report.path])
    assert.equal(view.valueOf({ label: 'JUnit report path' }), 'local/unsubmitted.xml')
  } finally {
    await view.unmount()
  }
})

test('prepares a bounded handoff and opens the source and raw report for the loaded workspace', async () => {
  const calls: unknown[] = []
  const view = await mount(panel, {
    host: mockHost({
      capabilities,
      requests: {
        'reports.workspaces': () => ({ workspaces: [workspace], suggestedId: workspace.id }),
        'reports.discover': () => ({ reports: reportOptions }),
        'reports.load': ({ path }) => path === passing.path ? passing : report,
        'reports.open': (request) => {
          calls.push(request)
          return { opened: true }
        }
      }
    })
  })

  try {
    assert.ok(view.find({ text: 'Failed 1' }))
    assert.ok(view.find({ text: 'src/settings.test.ts:15' }))
    await view.press({ text: 'Open report' })
    await view.press({ text: 'Open source' })
    assert.deepEqual(calls, [
      { workspaceId: workspace.id, path: report.path },
      { workspaceId: workspace.id, path: report.path, failureKey: 'failure-1', modifiedAt: report.modifiedAt }
    ])

    const rerun = 'npm test -- settings.test.ts'
    await view.type({ label: 'Rerun command (optional)' }, rerun)
    await view.press({ text: 'Prepare for agent' })
    const draft = view.valueOf({ label: 'Agent handoff' })
    assert.equal(typeof draft, 'string')
    assert.ok(String(draft).includes(rerun))
    assert.ok(String(draft).includes(report.path))
    assert.ok(String(draft).includes('Settings tests · saves settings'))
    assert.ok(String(draft).includes('src/settings.test.ts:15'))
    assert.ok(String(draft).includes('Trace summary'))
    assert.ok(String(draft).endsWith('…'))
    await view.select({ label: 'Discovered reports' }, passing.path)
    assert.match(view.summary().join('\n'), /No failures in this report/)
    assert.equal(view.find({ label: 'Agent handoff' }), null)
    assert.deepEqual(view.refusals, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('resolves a typed relative path after a manual workspace choice', async () => {
  const path = 'qa/mobile/junit.xml'
  const calls: unknown[] = []
  const view = await mount(panel, {
    locale: 'ru-RU',
    host: mockHost({
      capabilities,
      requests: {
        'reports.workspaces': () => ({
          workspaces: [workspace, { ...workspace, id: 'ws-2', name: 'QA' }],
          suggestedId: null
        }),
        'reports.discover': () => ({ reports: [] }),
        'reports.load': (request) => {
          calls.push(request)
          return { ...report, path }
        }
      }
    })
  })

  try {
    assert.equal(view.find({ label: 'Путь к отчёту JUnit' }), null)
    await view.select({ label: 'Рабочая область' }, 'ws-2')
    await view.type({ label: 'Путь к отчёту JUnit' }, path)
    await view.press({ text: 'Загрузить' })
    assert.deepEqual(calls, [{ workspaceId: 'ws-2', path }])
    assert.ok(view.find({ text: 'Упали 1' }))
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('ignores an earlier report when it resolves after a newer selection', async () => {
  let complete!: (report: TestReport) => void
  const delayed = new Promise<TestReport>((resolve) => { complete = resolve })
  let begin!: () => void
  const started = new Promise<void>((resolve) => { begin = resolve })
  let slow = false
  const view = await mount(panel, {
    host: mockHost({
      capabilities,
      requests: {
        'reports.workspaces': () => ({ workspaces: [workspace], suggestedId: workspace.id }),
        'reports.discover': () => ({ reports: reportOptions }),
        'reports.load': ({ path }) => {
          if (path !== report.path) return passing
          if (!slow) return report
          begin()
          return delayed
        }
      }
    })
  })

  try {
    slow = true
    const previous = view.press({ text: 'Load' })
    await started
    const next = view.select({ label: 'Discovered reports' }, passing.path)
    complete(report)
    await Promise.all([previous, next])
    assert.match(view.summary().join('\n'), /No failures in this report/)
    assert.equal(view.find({ text: 'Failed 1' }), null)
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})
