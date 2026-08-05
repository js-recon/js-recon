# Contributing to js-recon

For the full contributor guide — cloning, branch/PR workflow, codebase structure — see
[js-recon.io/contributing](https://js-recon.io/contributing). This file covers the policies that
apply once you're making a change here.

## Testing is required for new functionality

New functionality must ship with unit and/or smoke tests. See
[`contributing/testing.md`](contributing/testing.md) for how to write unit tests (Vitest), fuzz
tests (fast-check, for anything that parses untrusted bundle input), and smoke tests (the
`rules-smoke-test` CI workflow).

## Keep js-recon-docs in sync

Changes that affect user-facing behavior, CLI flags, exit codes, or install/usage instructions must
include a corresponding update to [`js-recon-docs`](https://github.com/js-recon/js-recon-docs) —
either in the same PR or a linked follow-up PR. Docs-only fixes don't need a corresponding js-recon
change.

## Static analysis

CI runs [ESLint](https://eslint.org/) (with
[`eslint-plugin-security`](https://github.com/eslint-community/eslint-plugin-security)) and
[CodeQL](https://codeql.github.com/) on every push and pull request. Run `npm run lint` locally
before pushing.

## Reporting vulnerabilities

Do not open a public issue for a security vulnerability — see [`SECURITY.md`](SECURITY.md) for the
reporting process and response SLAs. Bug reports and feature/tech-support requests use the GitHub
Issues templates linked from the [contributing page](https://js-recon.io/contributing).
