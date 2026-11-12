---
title: Configure OAuth 2.0 SSO
lastUpdated: 2026-11-12
---

# Configure OAuth 2.0 SSO

OAuth management requires Enterprise licensing and System Administrator access. Prepare a provider application whose redirect URL exactly matches the value shown by MyAgentRoam.

Configure an OAuth 2.0 authorization-code provider; automatic OIDC discovery is not provided. Register the complete HTTP or HTTPS callback generated from `MAR_PUBLIC_ORIGIN` after creating the provider, `/api/oauth/<providerKey>/callback`, with that provider; the provider may independently require HTTPS. Never include raw access tokens or user-information responses in screenshots or support requests.

1. In **Admin → OAuth**, create a unique provider key and a user-facing display name.
2. Enter HTTPS authorization, token, and user-information endpoints, client authentication, PKCE, scopes, and field mappings.
3. Save and test. Any configuration change disables the provider until a new test succeeds.
4. Enable it only after testing. Enable automatic account creation only when organization and role policy explicitly permits it.

Protect the client secret. Ambiguous email matches, an already-bound identity, invalid state, or mapping errors must be resolved by an administrator rather than bypassed.

Automatic account creation is off by default; when enabled, new users enter the root organization as Members. A frozen Enterprise license prevents new bindings, email matches, and automatic account creation, while eligible already-bound users may still sign in. If a test or callback fails, verify `MAR_PUBLIC_ORIGIN`, the callback allowlist, HTTPS endpoints, field mappings, and client configuration. The stored client secret is not shown; leave it blank when editing other fields to retain it.
