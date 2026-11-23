---
name: scenario
description: Set up a test scenario in the specmock mock API (data plus faults) from a plain-language description, e.g. "a frozen account with zero balance and payments failing with 503 twice". Use when the user wants to test how their app handles a specific API state or failure.
argument-hint: "<scenario in plain language>"
---

Set up this scenario in specmock: $ARGUMENTS

1. Call `describe_api` to learn the resources, their fields and the operations.
2. Turn the scenario into concrete state:
   - Data → `upsert_records`. Reuse existing records when the scenario refers to "an account" and doesn't need a new one.
     Keep cross-references consistent: ids in `*Id` fields must point at records that exist.
   - Failures, latency and flakiness → `add_fault`, with `times` for "the next N calls" and `probability` for "sometimes".
3. Verify with `list_records` / `list_faults`, or a `call_api` probe where it doesn't consume a limited fault.
4. Reply with a short table of what you set up (resource, id, key fields; fault id, match, effect), the base URL the
   app should call, and how to undo it (`clear_faults`, `reset`).

When the user later asks what happened, use `request_log` (filter with `only_errors`) and explain each failing request:
the validation error, the injected fault, or a missing record.
