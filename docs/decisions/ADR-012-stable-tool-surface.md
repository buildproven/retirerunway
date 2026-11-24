# ADR-012: A stable tool surface: run_tool, a live tool list, patch saves

- Status: accepted
- Date: 2026-11-24
- Requirements: REQ-MCP-73, REQ-MCP-74
- Standard: the shared agent-app template, rules 9 to 14

## Context

Claude reads a connector's tools and input schemas when a chat starts. The
web app does this for each new chat; the phone and desktop apps have been
reported to keep the list until the connector is re-added
(anthropics/claude-code#38324); and no client acts on
`notifications/tools/list_changed` mid-chat (anthropics/claude-code#62058,
#77314). Each RetireRunway release added tools or profile fields, so the
owner had to start a new chat to use them, and an open chat could not save a
new field (its copy of the save_profile schema rejected it).

## Decision

- One stable door: `run_tool` calls any registered tool by name with an open
  `arguments` object, validated on the server against the tool's current
  schema. Its own schema never changes.
- A live tool list in `get_briefing`, the first call of every chat, so the
  agent learns new tools from a result, not from the cached list.
- Patch saves: `update_profile` changes fields by path, with the merged
  profile checked strictly on the server.
- Compatibility rule: within a major version, tool names and the meaning of
  their arguments are never removed or changed; additions only.

## Consequences

- One more new chat is needed to pick up `run_tool` and `update_profile`
  themselves; after that, new tools and fields work in open chats.
- Direct calls with a stale schema still work for every existing field;
  new fields go through `update_profile` or `run_tool`.
- The same pattern applies to every MCP product through the shared
  standard.
