# RecordStuff repository instructions

- English is the canonical repository language. Keep paired Traditional Chinese reader documentation and the app's zh-TW catalog in sync; follow [CONTRIBUTING.md](CONTRIBUTING.md).
- The product and architecture are documented in [docs/system-design/README.md](docs/system-design/README.md). Keep function contracts, settings, IPC, and design decisions current when behavior changes.
- Preserve measured evidence under docs/verification. Raw historical records keep their original data/language; never turn an unverified result into a passing claim.
- Plans live in plans/. Follow the order and status in plans/README.md when asked to execute the next plan. Plans contain unfinished work only; completed/canceled plans are removed after durable information is captured in docs.
- After completing or changing a plan: update its scope/status, the plan index, README progress/commands, affected design documents, verification evidence, and paired translations. Remove completed plans and their translations when all conclusions have been migrated.
- Priorities: correctness, clarity, resilience, then performance. Avoid frameworks and abstractions for unscheduled work.
- Only macOS has been verified. Windows/Linux verification and Apple certification/notarization are not required for current delivery. The target is a downloadable self-signed macOS app with accurate first-launch instructions.
- Run pnpm check (typecheck + Vitest + build) after application changes. Check document links and git diff --check for documentation changes.
- Do not commit, push, or publish unless the user requests it.
