# Test Results

Review local JUnit XML reports in the Orca sidebar and collect a failed test's details for a coding agent.

## Use

1. Open **Test Results** and select a local workspace. The newest report in a supported location opens automatically. Enter a workspace-relative XML path to load another report.
2. Select a failure to see its assertion, logs and source path. **Open source** opens the file when the report names a file that exists in this workspace.
3. Optionally enter the project's rerun command. **Prepare for agent** creates an editable summary with the selected test, report, location and failure output. Copy the summary from the text field.

Typical locations include `junit.xml`, `test-results/junit.xml`, `target/surefire-reports/TEST-*.xml`, `target/nextest/default/junit.xml` and `build/test-results/test/TEST-*.xml`. The panel shows the report's modification time. The workspace branch identifies the checkout containing the report.

The worker reads UTF-8 reports up to 8 MiB. The panel counts test cases in the document, displays the first 100 failures and retains a link to the full report. The rerun command is included in the summary as text.

## Develop

```sh
orca plugin types . --json
npm ci
npm run typecheck
orca plugin test . --json
orca plugin check . --json
orca plugin validate . --json
```

Use `orca plugin inspect . --json` to review the local plugin's access and `orca plugin dev watch . --check --json` to load it for development.
