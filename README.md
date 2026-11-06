---
description: "Add one authenticated OneBot 11 account and scoped message delivery to a DSH profile."
kind: "package-bundle"
---
# dsh-qq-onebot

English | [中文](README.zh.md)

## Summary

This development bundle contributes one selected OneBot 11 account. It preserves protocol mentions, quotes, share cards and media references, checks account health, and classifies send receipts without retrying uncertain actions. It adds no model, persona or automatic reply. Local DSH profile installation has passed; the graphical settings and status pages remain unfinished. This is not a public release.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The candidate targets DSH 0.2.2-rc.1, Cordis 4.1 and Node 22.19 or 24. It is a bundle layer, not an application binary. A standard profile must supply the DSH credentials service. A separate OneBot 11 protocol endpoint must already exist; this package does not launch or log in QQ.

The inserted row is qq-onebot-transport and is disabled by default. Enabled configuration must name the exact account and allowed groups. Private conversations require allowPrivate; privateUsers can further restrict them. accessTokenEnv names a DSH credential reference, not a literal secret. Each new handshake resolves that reference again.

Forward mode uses an authenticated universal ws connection on loopback or wss remotely. Reverse mode listens only on loopback and accepts one authenticated universal connection. Separate API/Event sockets, HTTP transport and OneBot 12 are not supported.

The isolated installation used the profile cordis.patch.yml and remounted the row. A generated live settings form and graphical status panel are not implemented in this candidate. Do not treat schema export as proof that a settings page is usable.

The host service ctx.im publishes admitted messages and provides availability/send operations. ctx.qqOnebot exposes host-only source lookup, original message snapshots and scope-bound outbound byte references. A separate consumer decides whether to reply and owns durable request IDs.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[The bundle patch](cordis.patch.yml) inserts the disabled row. [The entry](src/index.ts) owns service registration and teardown. [The transport](src/transport.ts) verifies QQ identity separately from socket connectivity, pins active incoming references, shares membership probes and preserves sanitized diagnostics. [The socket](src/socket.ts) correlates RPC replies, bounds resources and joins shutdown.

</details>

<a id="model-experience"></a>
## Model Experience

Indirect. This bundle defines no model tools, changes no prompt and starts no model request. Chat, archive and media consumers must record any material they expose to a model through their own DSH session events. JSON/XML share content is untrusted data, never an instruction or authorization.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Receipts confirm server acceptance only; QQ phone display and playback require a separate authorized verification.
- Incoming deduplication and source retention are bounded in-memory caches, not a durable archive or exactly-once guarantee.
- One selected account per profile is supported. A second provider cannot silently replace its messaging service.
- Muting uses available member timestamps and observed ban notices; a protocol that omits mute evidence cannot prove every pre-existing whole-group mute.
- Files and merged-forward output require later explicit capability adapters; they are rejected rather than disguised as text or images.
- No protocol client, credentials, private persona, user archive or image collection is included.
- Real QQ, model API, UI and Linux checks have not been completed for this candidate.

## Further Exploration

- [Configuration fields](src/config.ts)
- [Tests](test/)

## Dev Note

Development candidate. Production deployments are unchanged.
