---
title: Configure OAuth 2.0 SSO
lastUpdated: 2026-09-25
---

# Configure OAuth 2.0 SSO

OAuth management requires Enterprise licensing and System Administrator access. Prepare a provider application whose redirect URL exactly matches the value shown by MyAgentRoam.

1. In **Admin → OAuth**, create a unique provider key and a user-facing display name.
2. Enter HTTPS authorization, token, and user-information endpoints, client authentication, PKCE, scopes, and field mappings.
3. Save and test. Any configuration change disables the provider until a new test succeeds.
4. Enable it only after testing. Enable automatic account creation only when organization and role policy explicitly permits it.

Protect the client secret. Ambiguous email matches, an already-bound identity, invalid state, or mapping errors must be resolved by an administrator rather than bypassed.
