# Security policy

## Private reporting

Do not report suspected vulnerabilities in public issues, discussions, or pull requests.
Email **achaosxyz@gmail.com**, the project's existing support contact, with a
subject beginning **[Security] MyAgentRoam**. Start with a minimal, redacted report;
coordinate privately before sending sensitive reproduction material.

Include the affected release or commit, component, deployment mode, prerequisites,
reproduction steps, expected and actual behavior, and potential impact. Use a
disposable example rather than real customer data. Never include passwords,
API keys, OAuth tokens, private keys, host UUIDs, License documents, or raw session logs.

Maintainers will triage the report, request clarification when needed, and coordinate
remediation and disclosure with the reporter. No fixed response or resolution SLA
is currently promised. Please keep exploit details private while coordination is ongoing.

## Versions

Report the exact affected version, even if it is not the newest release. This project
does not currently publish an LTS or security-backport schedule. Check release notes
for fixes; do not assume an older release receives security updates.

## Scope and safe testing

Relevant boundaries include authentication and authorization, Server/Node relay,
Workspace files, terminal and Agent execution, managed credentials, hosted-conversation
isolation, sharing, and enterprise access controls.

Test only on systems you own or have explicit permission to assess, using isolated
accounts, disposable data, and non-production resources. Do not access other users'
data, disrupt shared services, or publish credentials. This policy does not authorize
testing any third-party deployment or establish a bug-bounty program.

Self-hosting is not a sandbox. Agent tools and terminals can act with their service
account's permissions; configured model providers receive the context sent to them.
See the [security checklist](docs/help/en-US/deployment/security-checklist.md),
[data boundaries](docs/help/en-US/concepts/data-and-security.md), and
[licensing scope](LICENSING.md).
