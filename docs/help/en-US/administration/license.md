---
title: Community and Enterprise Licenses
lastUpdated: 2026-10-21
---

# Community and Enterprise Licenses

Community Edition provides the default single-user experience without a limit on registered Nodes. An Enterprise license enables organizations, additional users, resource sharing, SSO, and audit management.

A System Administrator opens **Admin → System Information**, copies the request code, and sends it privately to the issuer. Paste the complete returned License document into **License Authorization**, import it, and verify enterprise name and expiry before creating enterprise resources.

An expired or frozen license restricts enterprise management writes while preserving configured resources and normal work according to the displayed state. Import a valid replacement to restore management. Treat request codes and License documents as administrative data and do not publish them.

There is one program, image set and deployment baseline. Activation does not replace the installation. Every state requires the real host UUID; containers must mount it read-only, and startup fails if it is unavailable or invalid. License capabilities do not replace user and resource authorization.

## Why does Community require a host UUID?

Community and Enterprise use the same Server startup and host-identity mechanism.
Server derives a host fingerprint locally from the real UUID; Enterprise License
validation uses it to bind a License to that Server host. Community does not require
an Enterprise activation request or an online license-validation service.

This host-identity check is not an analytics upload. License verification is local;
to request Enterprise activation, an administrator deliberately sends the request
code (which contains the host fingerprint) to the issuer. Do not publish that code.
This does not imply that the entire product is offline: model providers, configured
integrations, and other network features have their own data flows.

Containers must mount the real host UUID read-only. A VM must expose a valid UUID;
missing or invalid identity blocks startup rather than falling back to a generated ID.
Moving Server to a host with a different UUID requires a replacement Enterprise License
bound to the new host. Community still requires the new host's valid UUID but no
Enterprise activation. Community is single-user and does not limit registered Nodes.

## Source licensing and permitted use

The EE author and licensor is **aCHAOS (achaosxyz@gmail.com)**. `ee/LICENSE` contains the full English MyAgentRoam Enterprise Source-Available License 1.0 (`MAR-ESAL-1.0`); the product root `LICENSING.md` explains its scope. It is not an OSI-approved open-source license. Independent Apache components and third-party materials retain their own licenses.

Community features are free for internal use, including a company's own commercial work and deployment on cloud infrastructure it controls. Enterprise features include organization and multi-user administration, enterprise roles and organizational permissions, shared-resource authorization, SSO, enterprise operation auditing and associated governance. Production use requires an Enterprise license, except for the limited frozen-state continuation specified in the terms; isolated non-production development and testing are also permitted.

An Enterprise license activates features, not redistribution, resale, third-party hosting, SaaS/API operation, OEM or white-label rights. Unactivated or activated status, free third-party access and source modifications do not create exceptions; there is no separate commercial or hosting authorization to purchase. Internal hosted conversations are not third-party hosting services. Your own independent code and output are not subject to the EE license merely because You use MAR. The full scope, exceptions and contribution terms are in `ee/LICENSE`.
