import { defineCheck, hostError } from 'orca/testing'
import type { TestReport, Workspace } from './protocol'

const workspace: Workspace = {
  id: 'filters',
  project: 'Example App',
  name: 'Search filters',
  branch: 'feature/search-filters'
}
const report: TestReport = {
  path: 'test-results/junit.xml',
  modifiedAt: Date.UTC(2026, 10, 18, 7, 20),
  tests: 42,
  passed: 39,
  failed: 2,
  skipped: 1,
  omittedFailures: 0,
  failures: [
    {
      key: 'test-1',
      suite: 'Search filters',
      className: 'FilterTests',
      name: 'retains the selected filters on page refresh',
      outcome: 'failure',
      file: 'src/search/filters.test.ts',
      source: 'src/search/filters.test.ts',
      line: 37,
      message: 'Expected the date range to remain selected after refresh.',
      output: 'Expected: "Last 30 days"\nReceived: "All time"\n    at filters.test.ts:37:25'
    },
    {
      key: 'test-2',
      suite: 'Search filters',
      className: 'FilterTests',
      name: 'loads saved filters from the existing account',
      outcome: 'error',
      message: 'Timed out waiting for the saved filters.',
      output: ''
    }
  ]
}
const capabilities = ['workspace:read']
const reports = [report, { path: 'reports/previous.xml', modifiedAt: report.modifiedAt - 150_000 }]
  .map(({ path, modifiedAt }) => ({ path, modifiedAt }))
const workspaceRequest = () => ({ workspaces: [workspace], suggestedId: workspace.id })
const reportsRequest = () => ({ reports })

export default defineCheck({
  failures: {
    capabilities,
    requests: {
      'reports.workspaces': workspaceRequest,
      'reports.discover': reportsRequest,
      'reports.load': () => report
    }
  },
  passing: {
    capabilities,
    theme: 'dark',
    requests: {
      'reports.workspaces': workspaceRequest,
      'reports.discover': reportsRequest,
      'reports.load': () => ({ ...report, tests: 42, passed: 42, failed: 0, skipped: 0, failures: [] })
    }
  },
  'no-reports': {
    capabilities,
    requests: {
      'reports.workspaces': workspaceRequest,
      'reports.discover': () => ({ reports: [] })
    }
  },
  'invalid-report': {
    capabilities,
    requests: {
      'reports.workspaces': workspaceRequest,
      'reports.discover': reportsRequest,
      'reports.load': () => { throw hostError('invalid_request', 'The file is not a valid JUnit report.') }
    }
  }
})
