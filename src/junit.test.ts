import { assert, test } from 'orca/testing'
import { parseJUnit } from './junit'

test('counts nested JUnit cases and preserves failure details and source metadata', () => {
  const result = parseJUnit(`<?xml version="1.0" encoding="UTF-8"?>
    <j:testsuites xmlns:j="urn:junit" tests="99" failures="98">
      <j:testsuite name="Web &amp; API" tests="45">
        <j:testsuite name="Reports">
          <j:testcase name="unfiltered" />
          <j:testcase name="selected &quot;rows&quot;" classname="reports.Export" file="tests/export.test.ts" line="42" time="0.075">
            <j:system-out><![CDATA[sent <query>&ok</query>]]></j:system-out>
            <j:failure message="expected 2 &#x2192; got 3">Expected &lt;2&gt;.<![CDATA[
at test (export.test.ts:42)]]></j:failure>
            <j:system-err>retry &amp; recover</j:system-err>
          </j:testcase>
          <j:testcase name="disabled"><j:skipped message="not this run" /></j:testcase>
        </j:testsuite>
        <j:testcase name="selected &quot;rows&quot;" classname="reports.Export" line="0" time="2e-5">
          <j:failure message="a secondary problem">assertion details</j:failure>
          <j:error type="TimeoutError">runner timed out</j:error>
        </j:testcase>
        <j:testcase name="disabled in C++" status="notrun" result="suppressed" />
      </j:testsuite>
    </j:testsuites>`)

  assert.deepEqual(result, {
    tests: 5,
    passed: 1,
    failed: 2,
    skipped: 2,
    omittedFailures: 0,
    failures: [
      {
        key: 'test-2',
        suite: 'Web & API › Reports',
        name: 'selected "rows"',
        className: 'reports.Export',
        outcome: 'failure',
        message: 'expected 2 → got 3',
        output: 'Expected <2>.\nat test (export.test.ts:42)\n\nstdout:\nsent <query>&ok</query>\n\nstderr:\nretry & recover',
        file: 'tests/export.test.ts',
        line: 42,
        duration: 0.075,
      },
      {
        key: 'test-4',
        suite: 'Web & API',
        name: 'selected "rows"',
        className: 'reports.Export',
        outcome: 'error',
        message: 'TimeoutError',
        output: 'assertion details\n\nrunner timed out',
        line: 0,
        duration: 0.00002,
      },
    ],
  })
})

test('accepts empty reports and ignores testcase-shaped extension content', () => {
  assert.deepEqual(parseJUnit('<testsuites/>'), {
    tests: 0, passed: 0, failed: 0, skipped: 0, failures: [], omittedFailures: 0,
  })
  const result = parseJUnit(`<testsuite name="Main">
    <properties><testcase name="metadata pruned"><failure /></testcase></properties>
    <testcase name="real test"><system-out><![CDATA[<failure />]]></system-out></testcase>
  </testsuite>`)
  assert.equal(result.tests, 1)
  assert.equal(result.passed, 1)
  assert.deepEqual(result.failures, [])
})

test('counts flat Node test runner cases alongside named suites', () => {
  const result = parseJUnit(`<testsuites>
    <testcase name="clear" classname="test" file="tests/filters.mjs" />
    <testcase name="restore range" classname="test" file="tests/filters.mjs">
      <failure type="testCodeFailure" message="All time differs from Last 30 days">assertion output</failure>
    </testcase>
    <testcase name="archived"><skipped type="skipped" message="true" /></testcase>
    <testsuite name="nested"><testcase name="also works" /></testsuite>
  </testsuites>`)
  assert.deepEqual([result.tests, result.passed, result.failed, result.skipped], [4, 2, 1, 1])
  assert.equal(result.failures[0].file, 'tests/filters.mjs')
  assert.equal(result.failures[0].key, 'test-2')
})

test('reads pytest locations from short and long tracebacks when the testcase has no file', () => {
  const report = (details: string, metadata = '') => parseJUnit(`<testsuite name="pytest">
    <testcase name="test_range" ${metadata}><failure>${details}</failure></testcase>
  </testsuite>`).failures[0]
  for (const trace of [
    'tests/search filters.py:10: in test_range\n    assert selected == expected',
    '    assert selected == expected\n\ntests/search filters.py:10: AssertionError'
  ]) {
    const failure = report(trace)
    assert.equal(failure.file, 'tests/search filters.py')
    assert.equal(failure.line, 10)
  }
  const explicit = report('inner.py:33: in run', 'file="tests/original.py" line="0"')
  assert.equal(explicit.file, 'tests/original.py')
  assert.equal(explicit.line, 0)
  assert.equal(report('retry this path: helpers.py:10').file, undefined)
})

test('keeps complete summary totals while clipping returned failure details', () => {
  const long = 'x'.repeat(5_000)
  const many = '<testcase name="again"><error /></testcase>'.repeat(101)
  const result = parseJUnit(`<testsuite>
    <testcase name="big" file="${long}" line="-1" time="Infinity">
      <failure message="${long}"><![CDATA[${long}]]></failure>
    </testcase>${many}<testcase name="passed" />
  </testsuite>`)
  assert.equal(result.tests, 103)
  assert.equal(result.passed, 1)
  assert.equal(result.failed, 102)
  assert.equal(result.failures.length, 100)
  assert.equal(result.omittedFailures, 2)
  const first = result.failures[0]
  assert.equal(first.message, 'x'.repeat(999) + '…')
  assert.equal(first.output, 'x'.repeat(3_999) + '…')
  assert.equal(first.file, undefined)
  assert.equal(first.line, undefined)
  assert.equal(first.duration, undefined)
  assert.equal(new Set(result.failures.map(({ key }) => key)).size, 100)
})

test('rejects non-JUnit documents, malformed XML, and DTDs', () => {
  assert.throws(() => parseJUnit('<report><testsuites/></report>'), /expected a testsuite or testsuites/i)
  assert.throws(() => parseJUnit('<testsuite><testcase></testsuite>'), /invalid JUnit XML/i)
  assert.throws(() => parseJUnit('<testsuites/><testsuites/>'), /invalid JUnit XML/i)
  assert.throws(() => parseJUnit('<testsuite>&unresolved;</testsuite>'), /invalid JUnit XML/i)
  assert.throws(() => parseJUnit('<!DOCTYPE testsuite SYSTEM "missing.dtd"><testsuite/>'), /DOCTYPE declarations/i)
  const internalDTD = '<!DOCTYPE testsuite [<!ENTITY report "unknown contents">]>'
  assert.throws(() => parseJUnit(`${internalDTD}<testsuite>&report;</testsuite>`), /DOCTYPE declarations/i)
})

test('limits XML size, nesting and element count even without test cases', () => {
  const deep = '<testsuite>'.repeat(65) + '</testsuite>'.repeat(65)
  assert.throws(() => parseJUnit(deep), /levels of nesting/i)
  const large = '<testsuite>' + ' '.repeat(8 * 1024 * 1024) + '</testsuite>'
  assert.throws(() => parseJUnit(large), /input size limit/i)
  const dense = '<testsuite>' + '<property />'.repeat(250_000) + '</testsuite>'
  assert.throws(() => parseJUnit(dense), /250000 elements/i)
})
