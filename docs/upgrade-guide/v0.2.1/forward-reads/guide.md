---
kind: upgrade-guide
description: "Complete typed settings and browser control clients gain four bounded forward-reading capacities."
---
# Upgrade scoped forward reading

## Change

Complete Config objects gain maxForwardNodes, maxForwardResources, maxForwardDepth and maxForwardCalls. The native owner form and control response include these fields. Saved profiles that omit them receive explicit schema defaults when resolved; no message archive or session format changes.

The Host service adds readForward(scope, rootMessageId, resourceId, signal). It reads only resources introduced by a retained admitted outer message or already-resolved children. Returned sender names and IDs are claims, not authentication. Reference-only nodes retain their message ID without performing a global get_msg lookup. Cached results contain original response data and scoped attachment references, not downloaded original media bytes.

## Migration

1. Upgrade the bundle and reload its native client. Resolve settings through Config or add the four fields to complete typed settings objects. Existing credential references, account identity and conversation allowlists remain applicable.
2. Call readForward only with the authenticated outer scope and its original message ID. Read returned failures explicitly; do not label capacity, malformed or timeout results complete. Record model-visible material through the consuming plugin's own session events.
3. Keep the original outer envelope when displaying nested nodes. Do not publish nodes as new inbound messages or grant administrator privileges from their claimed sender. Resolve media through its exact outer scope; original-byte downloading and merged-forward sending require separate adapters.
4. Re-run the loopback parser, cancellation, old-generation response and native-profile tests. No automatic recovery, retry, archive rewrite or historical message replay is introduced.
