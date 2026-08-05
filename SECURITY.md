# Security Policy

## Supported Versions

The three most recent versions receive security fixes. Older versions are unsupported.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report vulnerabilities by emailing: **shriyanss@ss0x00.com**

Include in your report:

- Description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected version(s)
- Any suggested mitigations, if known

You can expect an acknowledgement within **72 hours**, and no later than **14 days** from the initial report. If a vulnerability is confirmed, a fix will be prioritized based on severity, with a target of **60 days** to ship a patch for confirmed vulnerabilities affecting a publicly released version.

## Scope

js-recon is a security research tool. Reports are in scope if they affect:

- The js-recon CLI itself (arbitrary code execution, path traversal, unsafe deserialization, etc.)
- The Docker container image
- Dependencies with known CVEs that affect js-recon's attack surface

Out of scope:

- Vulnerabilities in targets analyzed by js-recon (that is the intended use case, not a bug)
- Issues requiring physical access or social engineering of the operator

## Disclosure Policy

Once a fix is available, coordinated public disclosure is preferred. Please allow reasonable time (up to 90 days) for a patch to be released before public disclosure.
