import { SaxesParser, type SaxesTagNS } from '../vendor/saxes.mjs'

export interface TestFailure {
  key: string
  suite: string
  className: string
  name: string
  outcome: 'failure' | 'error'
  message: string
  output: string
  file?: string
  line?: number
  duration?: number
}

export interface JUnitResult {
  tests: number
  passed: number
  failed: number
  skipped: number
  failures: TestFailure[]
  omittedFailures: number
}

const MAX_XML_LENGTH = 8 * 1024 * 1024
const MAX_DEPTH = 64
const MAX_ELEMENTS = 250_000
const MAX_FAILURES = 100
const MAX_LABEL = 512
const MAX_MESSAGE = 1_000
const MAX_OUTPUT = 4_000
const MAX_FILE_PATH = 1_024

type TextField = 'details' | 'stdout' | 'stderr'

interface Case {
  suite: string
  tag: SaxesTagNS
  outcome: 'passed' | 'skipped' | 'failure' | 'error'
  message: string
  capture: boolean
  details: string
  stdout: string
  stderr: string
}

type Frame =
  | { kind: 'suites' | 'suite'; suite: string }
  | { kind: 'case'; testCase: Case }
  | { kind: 'content'; testCase: Case; field: TextField }
  | { kind: 'other' }

function invalidXml(message: string): Error {
  return new Error(`Invalid JUnit XML: ${message}`)
}

function clipped(value: string, limit: number): string {
  if (value.length <= limit) return value
  return value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…'
}

function attribute(tag: SaxesTagNS, name: string): string {
  return tag.attributes[name]?.value ?? ''
}

function appendOutput(testCase: Case, field: TextField, text: string): void {
  if (!testCase.capture) return
  // Keep one extra character so the final formatting can signal truncation.
  const space = MAX_OUTPUT + 1 - testCase[field].length
  if (space > 0) testCase[field] += text.slice(0, space)
}

function startCase(tag: SaxesTagNS, suite: string, capture: boolean): Case {
  const status = attribute(tag, 'status').toLowerCase()
  const result = attribute(tag, 'result').toLowerCase()
  const skipped = status === 'notrun' || status === 'skipped' || result === 'suppressed' || result === 'skipped'
  return {
    suite,
    tag,
    outcome: skipped ? 'skipped' : 'passed',
    capture,
    message: '',
    details: '',
    stdout: '',
    stderr: '',
  }
}

function startCaseChild(testCase: Case, tag: SaxesTagNS): Frame {
  switch (tag.local) {
    case 'failure':
    case 'error':
      if (testCase.outcome !== 'error' || tag.local === 'error') {
        if (testCase.outcome !== tag.local || !testCase.message) {
          testCase.message = clipped((attribute(tag, 'message') || attribute(tag, 'type')).trim(), MAX_MESSAGE)
        }
        testCase.outcome = tag.local
      }
      if (testCase.details) appendOutput(testCase, 'details', '\n\n')
      return { kind: 'content', testCase, field: 'details' }
    case 'skipped':
      if (testCase.outcome === 'passed') testCase.outcome = 'skipped'
      return { kind: 'other' }
    case 'system-out':
      return { kind: 'content', testCase, field: 'stdout' }
    case 'system-err':
      return { kind: 'content', testCase, field: 'stderr' }
    default:
      return { kind: 'other' }
  }
}

function startFrame(tag: SaxesTagNS, parent: Frame | undefined, capture: boolean): Frame {
  if (!parent || parent.kind === 'suites' || parent.kind === 'suite') {
    const suite = parent?.suite ?? ''
    if (tag.local === 'testsuites') return { kind: 'suites', suite }
    if (tag.local === 'testsuite') {
      const name = clipped(attribute(tag, 'name').trim(), MAX_LABEL)
      return { kind: 'suite', suite: clipped([suite, name].filter(Boolean).join(' › '), MAX_LABEL) }
    }
    if (!parent) throw invalidXml('expected a testsuite or testsuites root element.')
    if (tag.local === 'testcase') {
      return { kind: 'case', testCase: startCase(tag, suite, capture) }
    }
  }
  if (parent?.kind === 'case') return startCaseChild(parent.testCase, tag)
  if (parent?.kind === 'content') return parent
  return { kind: 'other' }
}

function sourceMetadata({ tag, details }: Case): Pick<TestFailure, 'file' | 'line' | 'duration'> {
  const metadata: Pick<TestFailure, 'file' | 'line' | 'duration'> = {}
  let file = attribute(tag, 'file')
  let line = attribute(tag, 'line').trim()
  if (!file.trim()) {
    // pytest's default xunit2 output puts the location in its short or long traceback.
    const frame = /^([^\s<>][^\r\n<>]*?\.py):(\d+): (?:in \S|(?:[\w.]+(?:Error|Exception)|Failed)\b)/m.exec(details)
    if (frame) {
      file = frame[1]
      line = frame[2]
    }
  }
  if (file.trim() && file.length <= MAX_FILE_PATH) metadata.file = file

  if (/^\d+$/.test(line) && Number.isSafeInteger(Number(line))) metadata.line = Number(line)

  const time = attribute(tag, 'time').trim()
  if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(time) && Number.isFinite(Number(time))) {
    metadata.duration = Number(time)
  }
  return metadata
}

function caseOutput(testCase: Case): string {
  const sections = [testCase.details.trim()]
  if (testCase.stdout.trim()) sections.push(`stdout:\n${testCase.stdout.trim()}`)
  if (testCase.stderr.trim()) sections.push(`stderr:\n${testCase.stderr.trim()}`)
  return clipped(sections.filter(Boolean).join('\n\n'), MAX_OUTPUT)
}

function finishCase(result: JUnitResult, testCase: Case): void {
  result.tests += 1
  if (testCase.outcome === 'passed' || testCase.outcome === 'skipped') {
    result[testCase.outcome] += 1
    return
  }

  result.failed += 1
  if (result.failures.length >= MAX_FAILURES) {
    result.omittedFailures += 1
    return
  }

  const { tag } = testCase
  result.failures.push({
    key: `test-${result.tests}`,
    suite: testCase.suite,
    className: clipped(attribute(tag, 'classname').trim(), MAX_LABEL),
    name: clipped(attribute(tag, 'name').trim(), MAX_LABEL),
    outcome: testCase.outcome,
    message: testCase.message,
    output: caseOutput(testCase),
    ...sourceMetadata(testCase),
  })
}

export function parseJUnit(xml: string): JUnitResult {
  if (xml.length > MAX_XML_LENGTH) throw invalidXml('the report exceeds the input size limit.')

  const result: JUnitResult = { tests: 0, passed: 0, failed: 0, skipped: 0, failures: [], omittedFailures: 0 }
  const stack: Frame[] = []
  const parser = new SaxesParser({ xmlns: true })
  let elements = 0

  parser.on('error', (error) => { throw invalidXml(clipped(error.message, MAX_MESSAGE)) })
  parser.on('doctype', () => { throw invalidXml('DOCTYPE declarations are unsupported.') })
  parser.on('opentag', (tag) => {
    if (stack.length >= MAX_DEPTH) throw invalidXml(`the report exceeds ${MAX_DEPTH} levels of nesting.`)
    elements += 1
    if (elements > MAX_ELEMENTS) throw invalidXml(`the report exceeds ${MAX_ELEMENTS} elements.`)
    stack.push(startFrame(tag, stack.at(-1), result.failures.length < MAX_FAILURES))
  })
  parser.on('closetag', () => {
    const frame = stack.pop()
    if (frame?.kind === 'case') finishCase(result, frame.testCase)
  })

  function collectText(text: string): void {
    const frame = stack.at(-1)
    if (frame?.kind === 'content') appendOutput(frame.testCase, frame.field, text)
  }
  parser.on('text', collectText)
  parser.on('cdata', collectText)

  // Saxes decodes predefined XML entities and numeric references locally.
  parser.write(xml).close()
  return result
}
