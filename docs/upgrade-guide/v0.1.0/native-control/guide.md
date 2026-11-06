---
kind: upgrade-guide
description: "The 0.2 candidate adds an owner controller and requires native configuration and Remote services."
---

# Upgrade the 0.1 candidate to native control

## Change

The 0.1 bundle contained only qq-onebot-transport. The 0.2 bundle also mounts qq-onebot-control and publishes ./control and ./client. It adds ConfigEditor and Typert protocol peers; its Web client uses the native gateway, locale, renderer and plugin manager. Existing transport fields retain their names. No persistent chat or memory format changes.

## Migration

1. Back up the profile's package manifest and configuration, then update its dsh-qq-onebot dependency to the 0.2 candidate through DSH plugin management. Keep dsh-im-kit at 0.2.0 and the declared DSH peers at 0.2.2-rc.1.
2. Keep the existing transport entry ID qq-onebot-transport. If the profile renames it, set qq-onebot-control.config.targetEntryId to that exact ID. A controller never selects an arbitrary matching entry.
3. Supply the DSH credentials and ConfigEditor services. The standard Web profile supplies the Remote services and native page. A transport-only profile can disable the controller row when it deliberately does not provide those services.
4. Restart the profile through dsh. Open Plugins → dsh-qq-onebot and confirm saved settings match the intended account. A disabled transport keeps its configuration page. Socket connection, account verification and online evidence are separate indicators.
5. Review unsaved edits before reconnecting. A stale revision must be refreshed or discarded; reconnection never retries previous messages. See the [package guide](../../../../README.md#verify-this-package) for isolated installation and Web checks.
