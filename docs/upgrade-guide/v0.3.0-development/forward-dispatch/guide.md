---
kind: upgrade-guide
description: "Compose retained forward outputs with a bounded Host resolver and explicit backend forward writes."
---
# Upgrade merged-forward dispatch

## Change

OneBotTransport adds sendForwardNodes(scope, nodes, signal), registerForwardDispatcher(dispatcher) and messageSnapshot(scope, id). A sole outbound forward part is delegated to the installed Host resolver. Without that resolver it returns failed/unavailable. Mixed forward and ordinary parts remain rejected. No configuration fields, persisted records, credentials or session formats change.

Node writes use the backend's send_group_forward_msg or send_private_forward_msg extension. Node order, supported media bytes and sender display claims are preserved; the backend chooses delivery timestamps. Sender claims grant no authorization. Cached reference nodes require an unexpired message in the exact destination scope. Files, unresolved forward resources and unsupported segments reject the entire write. A timeout after dispatch remains uncertain and is never automatically retried.

## Migration

1. Upgrade the bundle. Existing profiles, native settings and ordinary sends continue to work without a forward consumer. No archive migration or historical replay is required.
2. Install an explicit retained-output resolver before submitting a sole forward part. Register it only from a trusted Host plugin and retain its disposer. Resolve complete nodes and register originals in their exact destination scope before calling sendForwardNodes; release temporary media after the call settles.
3. Keep operation deduplication and uncertain-send reconciliation in the durable delivery consumer. Calling sendForwardNodes directly makes one attempt per invocation and does not establish an exactly-once guarantee.
4. Use messageSnapshot for cached normalized quote content. It returns a detached copy with the original attachment handles, makes no global get_msg request and never republishes the quoted message. Record any model-visible material through the consuming plugin's session events.
