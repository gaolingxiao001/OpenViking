# lark-daemon

A single-user local Lark agent pipe. These terms name the seams this repo actually owns.

## Language

**Conversation policy**:
The assembled text a runtime is allowed to see: base markdown plus harness, OpenViking, and optional meeting-audio plugins.
_Avoid_: system prompt file, kernel, instructions blob

**Harness**:
The inbound pipe from a accepted Lark event to `AgentRuntime.submit`.
_Avoid_: daemon class, orchestrator, coordinator

**OpenViking connection**:
`OPENVIKING_*` environment plus the agent-side skill/MCP tools. The daemon does not recall or write memory.
_Avoid_: OV client, memory service, daemon recall

**Meeting plugin**:
A standalone inbound source. Live ASR finals become text items on the same submit seam as chat.
_Avoid_: meeting stack, audio runtime, media supervisor (those are internals)

**Lark connection**:
lark-cli subscribe inbound and the trusted outbound tools.
_Avoid_: Lark client vs tools as two products
