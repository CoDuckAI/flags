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

Use GitHub's private vulnerability reporting for `CoDuckAI/flags` when the **Report a
vulnerability** option is available in the Security tab. If it is unavailable, open an issue
requesting a private reporting channel without including vulnerability details. Never put
exploitation details, customer data or credentials in a public issue.
