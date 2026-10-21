# Licensing scope

The public repository contains one product, not separate Community and Enterprise
builds. Its unactivated state is Community; an Enterprise license activates the
corresponding Enterprise features in the same installation.

- The independent public core, including Agent, Node, Protocol, Server Core, Web
  Core and marctl, retains its Apache-2.0 license. The Apache text is in `LICENSE`.
- `ee/`, the product composition in `mar-server/` and `mar-web-console/`, and
  their combined product artifacts are not offered under the root Apache license.
  Their terms are the MyAgentRoam Enterprise Source-Available License 1.0
  (`MAR-ESAL-1.0`, local identifier `LicenseRef-MAR-ESAL-1.0`) in `ee/LICENSE`.
  Private package manifests use that identifier without checkout-relative license
  paths. Product containers include the full text as `LICENSE.ee`.
- Third-party components retain their respective copyright and license notices.

## Author and terms

The EE author and licensor is **aCHAOS**, reachable at **achaosxyz@gmail.com**.
Licensing grants apply only to rights the licensor owns or may license. Existing
contributor and third-party attribution remains intact; naming the licensor does
not transfer another author's copyright.

This is a source-available license, not an OSI-approved open-source license. The
local identifier does not claim official SPDX registration. The English text in
`ee/LICENSE` controls; this summary is not a substitute for the full terms.

## Permitted use and limits

Community features are free for personal or organizational internal use,
including a company's own commercial work and deployment on cloud infrastructure
it controls. Isolated non-production evaluation, development and security
research are permitted. Enterprise features require the signed Enterprise
License, except for isolated development/testing and the existing limited
frozen-state continuation specified in the terms.

Enterprise features comprise organization and multi-user administration,
enterprise roles and organizational permissions, shared-resource authorization,
SSO, enterprise operation auditing and associated governance. Workspaces, Agent
execution, files, Git, terminals, personal configuration, templates and internal
HostedConversation functionality are not Enterprise features merely because
the product includes EE.

An Enterprise License activates features, not redistribution or service-provider
rights. Whether unactivated or activated, recipients may not redistribute,
resell, publish independent EE forks or source mirrors, offer third-party
hosting/cloud services, SaaS/API access, OEM, white-label or bundled delivery of
the EE-containing product. Free third-party access and indirect commercial models
are not exceptions. No separate commercial, reseller or hosting authorization is
offered. Necessary internal copies, browser delivery to authorized internal
users and deliberate contributions to the official project are permitted as
specified in the license.

Independent Apache components and users' own independent output are not
relicensed or restricted by these EE terms. Contributors retain copyright;
intentional new EE contributions grant the official project the rights stated
in Section 8, without imposing retroactive terms on previous contributions.

## Release checks

`node scripts/check-product-license.mjs` verifies the final license identifier
and ordered, nonempty required sections and rejects missing, empty, draft or
incomplete text.
It does not certify legal enforceability, clear third-party rights, or authorize
publication. Local development, building and testing are unaffected. Release
maintainers remain responsible for the actual code and third-party notices.
