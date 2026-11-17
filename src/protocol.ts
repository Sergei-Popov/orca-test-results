import type { JUnitResult, TestFailure } from './junit'

export interface Workspace {
  id: string
  name: string
  project: string | null
  branch: string | null
}

export interface ReportOption {
  path: string
  modifiedAt: number
}

export interface ReportFailure extends TestFailure {
  source?: string
}

export interface TestReport extends Omit<JUnitResult, 'failures'> {
  path: string
  modifiedAt: number
  failures: ReportFailure[]
}

declare module 'orca' {
  interface PluginRequests {
    'reports.workspaces': { output: { workspaces: Workspace[]; suggestedId: string | null } }
    'reports.discover': { input: { workspaceId: string }; output: { reports: ReportOption[] } }
    'reports.load': { input: { workspaceId: string; path: string }; output: TestReport }
    'reports.open': {
      input: { workspaceId: string; path: string; failureKey?: string; modifiedAt?: number }
      output: { opened: boolean }
    }
  }
}
