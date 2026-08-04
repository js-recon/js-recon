# JS Recon

![NPM Licence](https://img.shields.io/npm/l/%40js-recon%2Fjs-recon) ![GitHub repo size](https://img.shields.io/github/repo-size/js-recon/js-recon) ![NPM Downloads](https://img.shields.io/npm/dm/%40js-recon%2Fjs-recon) ![GitHub commit activity (dev)](https://img.shields.io/github/commit-activity/w/js-recon/js-recon/dev) ![NPM Last Update](https://img.shields.io/npm/last-update/%40js-recon%2Fjs-recon) ![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/js-recon/js-recon) [![Plumber Score](https://score.getplumber.io/github.com/js-recon/js-recon.svg)](https://score.getplumber.io/github.com/js-recon/js-recon)

<p align="center">
  <a href="https://js-recon.io">
    <img src="https://js-recon.io/img/js-recon-logo.png" alt="JS Recon Logo" width="100">
  </a>
</p>

A powerful tool for JavaScript reconnaissance. `js-recon` helps you discover, download, and analyze JavaScript files to uncover endpoints, secrets, and other valuable information from any web application running supported frameworks.

It can also reconstruct HTTP requests that the app makes to the server, and output them to the OpenAPI spec.

## Installation

### Homebrew (macOS and Linux)

```bash
brew tap js-recon/tap
brew install js-recon
```

This always installs the latest **stable** release. For the latest alpha or beta prerelease instead:

```bash
brew install js-recon/tap/js-recon-alpha
brew install js-recon/tap/js-recon-beta
```

To update:

```bash
brew update && brew upgrade js-recon
```

> **Note:** If you installed JS Recon before the move to the `js-recon` GitHub organization, you may still have the old `shriyanss/tap` tapped locally. Since that repo was renamed (not deleted), Homebrew still resolves it, leaving two taps that both serve a formula named `js-recon` — causing errors like `Formulae found in multiple taps` or `Refusing to load formula ... from untrusted tap ...`. Fix with `brew untap shriyanss/tap` before installing from `js-recon/tap`.
>
> **Note:** After installing via Homebrew, the `lazyload` subcommand requires a Chromium browser. Run `brew info js-recon` for setup instructions.

### npm (all platforms)

This tool requires Node.JS and `npm` to be installed. The [official download page](https://nodejs.org/en/download) can be referred. Please install **22.17.0 (LTS)** or later. Downloading older versions might break the tool.

To install the tool globally, run:

```bash
npm i -g @js-recon/js-recon
```

For detailed installation and setup process, please refer to the [Installation page](https://js-recon.io/docs/docs/installation)

## Framework Support

The features in JS Recon tool are built after thorough research on apps running different frameworks.

Full pipeline support (lazyload → map → analyze → report) is available for: **Next.js**, **Vue.js**, **Nuxt.js**, **React**, **Svelte/Astro**, and **Angular** (v17+ / esbuild).

Please refer to the [Framework Support](https://js-recon.io/docs/docs/framework-support) page for detailed information on feature compatibility across different frameworks.

## Quick Start

```bash
# Get a list of all commands
js-recon --help

# Get help for a specific command
js-recon <command> --help
```

To launch a quick assesment against a target, the `run` module can be used to automate other modules

```bash
js-recon run -u https://app.example.com
```

`run`, `lazyload`, and `fingerprint` accept one target, repeated `-u` options, a comma-separated list,
or a text file containing one HTTP(S) URL per line:

```bash
js-recon run -u https://one.example.com -u https://two.example.com
js-recon run -u 'https://one.example.com,https://two.example.com'
js-recon run -u ./targets.txt
```

For `run`, an existing empty output directory is reused. If it contains files, js-recon preserves it
and selects the next available sibling (`output-2`, `output-3`, and so on). Use
`--output-overwrite` only when the contents of a previously created js-recon output should be
replaced. Unowned directories are never recursively cleared.

## Configuration

On first use, js-recon creates `~/.config/js-recon/config.yaml` with restrictive permissions and a key for every command option. Values resolve in this order:

1. Environment variables
2. Command-line flags
3. YAML configuration
4. Built-in defaults

Use `JS_RECON_<COMMAND>_<OPTION>` for any command option—for example, `JS_RECON_RUN_THREADS=8`—or select another config file before the subcommand:

```bash
js-recon --config ./operator.yaml run -u https://app.example.com
```

Targets may be configured as a YAML list. An environment value or one or more command-line `-u`
flags replace the entire YAML list according to the precedence above:

```yaml
commands:
    run:
        url:
            - https://one.example.com
            - https://two.example.com
```

See [`config.dist.yaml`](config.dist.yaml) for the complete schema. The existing `proxy --config` and `mcp --config` flags remain command-specific; place the application-level `--config` before those subcommands to avoid ambiguity.

Oxylabs CDN/WAF fallback is opt-in. Add non-empty `oxylabs.username` and `oxylabs.password` values to an explicitly selected YAML config, then enable `--oxylabs-waf-fallback` on `run` or `lazyload`. Direct requests remain the default; only strongly identified CDN/WAF blocks are retried through Oxylabs. The default paid-request limits are 10 per origin, 100 total, and 25 distinct origins per run:

```bash
js-recon --config ./operator.yaml run \
  --oxylabs-waf-fallback \
  -u https://app.example.com
```

`JS_RECON_OXYLABS_USERNAME`, `JS_RECON_OXYLABS_PASSWORD`, and `JS_RECON_OXYLABS_COUNTRY` override their YAML values unless `--ignore-proxy-env` is set.

## Commands

`js-recon` provides a suite of commands for comprehensive JavaScript analysis. For detailed usage and examples, please refer to its full documentation.

| Command       | Description                                                                      | Documentation                                                  |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `lazyload`    | Downloads dynamically loaded JavaScript files from a target.                     | [Read Docs](https://js-recon.io/docs/docs/modules/lazyload)    |
| `endpoints`   | Extracts API endpoints and client-side paths from JS files.                      | [Read Docs](https://js-recon.io/docs/docs/modules/endpoints)   |
| `strings`     | Extracts strings, URLs, and potential secrets from JS files.                     | [Read Docs](https://js-recon.io/docs/docs/modules/strings)     |
| `map`         | Maps function calls and analyzes code, with optional AI-powered descriptions.    | [Read Docs](https://js-recon.io/docs/docs/modules/map)         |
| `proxy`       | Routes requests through AWS API Gateway, SOCKS5/HTTP, or Oxylabs proxies.        | [Read Docs](https://js-recon.io/docs/docs/modules/proxy)       |
| `run`         | Runs all analysis modules automatically on a target.                             | [Read Docs](https://js-recon.io/docs/docs/modules/run)         |
| `analyze`     | Analyzes the code.                                                               | [Read Docs](https://js-recon.io/docs/docs/modules/analyze)     |
| `report`      | Generates a report from the analysis modules.                                    | [Read Docs](https://js-recon.io/docs/docs/modules/report)      |
| `mcp`         | AI-powered interactive CLI, one-shot chat, and MCP stdio server.                 | [Read Docs](https://js-recon.io/docs/docs/modules/mcp)         |
| `fingerprint` | Detects the JavaScript framework used by a target URL (JSON/JSONL output).       | [Read Docs](https://js-recon.io/docs/docs/modules/fingerprint) |
| `refactor`    | Recovers readable JSX and strips library code from React (webpack/Vite) bundles. | [Read Docs](https://js-recon.io/docs/docs/modules/refactor)    |
| `load`        | Populates the response cache from a Caido or Burp Suite export.                  | [Read Docs](https://js-recon.io/docs/docs/modules/load)        |
| `cs-mast`     | Computes CS-MAST structural hashes for JS files and finds hash collisions.       | [Read Docs](https://js-recon.io/docs/docs/modules/cs-mast)     |
| `sourcemaps`  | Extracts original source files from `.map` sourcemap files.                      | [Read Docs](https://js-recon.io/docs/docs/modules/sourcemaps)  |
| `completion`  | Generates shell completion scripts for bash, zsh, or fish.                       | [Read Docs](https://js-recon.io/docs/docs/modules/completion)  |

## Key Features

- Downloads all dynamically loaded JS files (refered as `lazyload`) from website with supported frameworks
- Use API gateway to rotate IP addresses to bypass firewall
- Extract strings from the discovered JS files, and extract potential secrets, endpoints, etc. from them (built-in scanner via `--secrets`; TruffleHog integration via `--trufflehog`)
- Endpoints modules extracts client-side paths from the app
- Map feature analyzes the JS files and outputs it to a JSON file. An interactive mode can be then used to analyze it
- Reconstruct HTTP requests that the app makes to the server, and output them to the OpenAPI spec
- Run analyze to find potential issues in JS code and the HTTP requests the app makes
- Generate a report from the analyze module (optional active endpoint probing via `sj`/swagger-jacker integration using `--sj`)

## Example Scenario

Refer to [this page](https://js-recon.io/docs/docs/example-scenarios/next-js) where an example scenario of running this tool against a Next.JS target is demonstrated.

## Documentation

For detailed guides, command options, and advanced usage examples, please check out the JS Recon Site at https://js-recon.io

## Labs

<p align="center">
  <img src="https://github.com/js-recon/js-recon-labs/blob/main/static/labs-banner.png?raw=true" alt="JS Recon Labs" width="300"/>
</p>

Labs to test JS Recon tool are available in the [JS Recon Labs repository](https://github.com/js-recon/js-recon-labs). [Labs walkthroughs](https://js-recon.io/labs) are also available.

## Contributing

Please refer to the [Contributing](https://js-recon.io/contributing) page for detailed information on contributing to this project.

## License

JS Recon is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
