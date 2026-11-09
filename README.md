---
description: "Add one authenticated OneBot 11 account and scoped message delivery to a DSH profile."
kind: "package-bundle"
---
# dsh-qq-onebot

English | [中文](README.zh.md)

## Summary

This preview bundle contributes one selected OneBot 11 account and a native Web configuration page. It preserves mentions, quotes, share cards and media references, checks account health, and classifies receipts without retrying uncertain actions. Its owner page keeps drafts, saved revisions and live connection evidence separate. It adds no model, persona or automatic reply. An existing OneBot service is required.

## Table of Contents

- [Use this package](#use-this-package)
- [Verify this package](#verify-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The candidate targets DSH 0.2.2-rc.1 and Cordis 4.1. That published Host requires Node >=24.9.0; Node 22 tests are compatibility probes. It is a bundle layer, not an application binary. The profile supplies credentials and ConfigEditor; the native Web profile also supplies Typert registry, gateway, remote access and plugin management. A OneBot 11 endpoint must already exist; this package does not launch or log in QQ.

The bundle inserts qq-onebot-transport, disabled by default, and a separate qq-onebot-control row. Enabled configuration must name the exact account and allowed groups. Private conversations require allowPrivate; an empty privateUsers list allows everyone, while a nonempty list restricts access. accessTokenEnv names a DSH credential reference, never a literal secret. Each new handshake resolves that reference again.

Forward mode uses an authenticated universal ws connection on loopback or wss remotely. Reverse mode listens only on loopback and accepts one authenticated universal connection. Separate API/Event sockets, HTTP transport and OneBot 12 are not supported.

For an existing DSH profile, install the release archive; its messaging-library dependency is fetched automatically:

```sh
dsh plugin --profile MY_PROFILE add https://github.com/Soldsix/dsh-qq-onebot/releases/download/v0.4.0-development/dsh-qq-onebot-0.4.0-development.tgz
```

After installing the bundle with dsh plugin --profile PROFILE add ARCHIVE, open Plugins → dsh-qq-onebot in the native Web app. The page edits connection, access and advanced limits. Saving uses ConfigEditor's validated, transactional profile edit; it preserves untouched expressions and rejects a stale revision. Activation failure rolls back through the Host editor. Reconnection uses saved settings and never resends messages.

The controller survives transport disable/reload and admits only the trusted Host owner, independently of generic Remote policy. It checks credential presence without reading secret values. The status panel distinguishes an active entry, socket connection, verified account and fresh online evidence; saving alone does not prove QQ is online.

The host service ctx.im publishes admitted messages and provides availability/send operations. ctx.qqOnebot exposes host-only source lookup, original message snapshots and scope-bound outbound byte references. A separate consumer decides whether to reply and owns durable request IDs.

### Scoped forward reading

Host readers call ctx.qqOnebot.readForward(scope, rootMessageId, resourceId, signal) using a retained admitted outer message. Only resources introduced by that message or already-read descendants can be requested; a child group ID cannot change scope. Results are resolved or failed with a stable reason. Names and IDs are labelled claimedSender, never authentication, new inbound messages, commands or administrator authorization.

Reads retain node order, ordinary reply IDs, inline nodes and the original response. Reference-only nodes retain referenceMessageId without global get_msg lookup. Concurrent reads of one exact root/resource share one call; cancelling a waiter preserves other readers, and the last waiter leaving stops the call. Cached snapshots are independent copies. Disconnect cancels old-generation calls; late responses cannot replace a new result. No automatic retry occurs.

maxForwardNodes, maxForwardResources, maxForwardDepth and maxForwardCalls are editable in native advanced settings; maxReferenceBytes also bounds the complete retained cache. Excess data is rejected intact without truncation or partial media grants. Successful fetches refresh outer-reference retention; cache hits do not. Forwarded media locations use mediaSource under the original outer scope; this does not prove original-byte download, image recognition or complete cross-resource expansion.

The parser covers [OneBot standard nodes](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#get_forward_msg-获取合并转发消息) and [NapCat response nodes](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/action/go-cqhttp/GetForwardMsg.ts). Conflicting nonempty content fields fail explicitly. Original downloading, model-visible rendering and recursive resource policy belong to independent consumers; see the [reading upgrade guide](docs/upgrade-guide/v0.2.1/forward-reads/guide.md).

### Explicit merged-forward output

Trusted Host adapters call sendForwardNodes(scope, nodes, signal), using [the backend forward extension](https://github.com/NapNeko/NapCatQQ/blob/98d781d19815d1625b24d717ce280ecf0a4f6d0c/packages/napcat-onebot/action/go-cqhttp/SendForwardMsg.ts). It checks current online/mute evidence, node/depth/byte capacities and exact outbound-media scope. Supported bytes are sent unchanged; reference-only nodes require unexpired admitted messages in the same scope. Unsupported content rejects the whole write. The backend chooses delivery timestamps; sender display fields remain claims.

registerForwardDispatcher installs one Host resolver for a sole outbound forward part; its disposer aborts and joins pending sends before replacement. A consumer must retain complete content, resolve its opaque reference and own operation deduplication. Without a resolver the part fails unavailable; mixed ordinary/forward parts remain rejected. messageSnapshot reads detached cached normalized content with its existing attachment handles, without reparsing or global get_msg. See the [dispatch upgrade guide](docs/upgrade-guide/v0.3.0-development/forward-dispatch/guide.md).

<a id="verify-this-package"></a>
## Verify this package

Run npm run check in this repository. Build and pack the candidate before integration tests. Each test starts the supported dsh CLI with a new isolated profile and synthetic loopback endpoints; it never opens a user browser or connects to QQ. The package installs the pinned dsh-im-kit 0.2.1 public GitHub archive automatically; no prior library installation is required. Integration tests download that archive as installation evidence, or accept --im-kit-archive for an explicit test input. No sibling checkout or production profile is read.

```sh
npm pack --pack-destination artifacts
npm run test:dsh
npm run test:control
npm run test:web
npm run test:consumer -- --im-kit-archive PATH_TO_VERIFIED_LIBRARY_TGZ
```

The Web test requires Playwright's matching Chromium headless shell. Set PLAYWRIGHT_BROWSERS_PATH to a test-only directory and run node node_modules/playwright/cli.js install chromium --only-shell there before test:web. The test uses a fresh browser profile; output goes to .test-artifacts. The source repository contains all three harnesses and probes.

The QA dependency overrides are tested development inputs, not an upgrade of an installed consumer's Host. Plugin dependency overrides do not propagate into a consuming profile, and prebuilt Host assets may embed other versions. Apply and verify Host dependency updates separately; an npm audit result covers its recorded package tree only.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[The bundle patch](cordis.patch.yml) separates transport from owner control. [The entry](src/index.ts) owns messaging services; [control](src/control.ts) edits only its exact configured entry. [The native page](src/client/page.tsx) retains unsaved input during status refresh. [The transport](src/transport.ts) verifies identity, pins active references and shares member probes. [The socket](src/socket.ts) correlates replies, bounds resources and joins shutdown.

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
- File output remains unsupported. Complete merged-forward assembly, durable deduplication and original downloading require explicit consumer adapters; transport dispatch alone does not implement them.
- No protocol client, credentials, private persona, user archive or image collection is included.
- Native Web checks use isolated synthetic endpoints. Real QQ, model API and desktop-client verification require separate authorized checks.

## Further Exploration

- [Configuration fields](src/config.ts)
- [Tests](test/)

## Dev Note

Preview release. Its declared message transport and native controls are verified separately from QQ client delivery.
