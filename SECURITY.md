# Security policy

## Trust boundaries

- Flags control product behavior and release exposure; they do not grant authorization.
- Entitlements and sensitive targeting attributes must come from authenticated server-side
  state, never untrusted browser input.
- Do not send complete rulesets to browsers. Evaluate on the server and expose only an
  explicit allowlist of results.
- Treat SDK read keys as server secrets. Administration keys can change production behavior
  and require stronger storage and rotation controls.
- Use TLS for every non-local HTTP/SSE connection. Insecure remote URLs are rejected unless
  an application explicitly opts into the development override.
- Do not put secrets, payment details, or unnecessary personal data in rulesets or telemetry.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories for the
`CoDuckAI/flags` repository. Do not open a public issue containing exploitation details or
credentials.
