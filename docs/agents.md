# Sub-Agents

Three project sub-agents, each with a **strict, narrow scope** — so a PDF-parsing change isn't rubber-stamped by the same context thinking about pricing. The point isn't ceremony; it's isolation of judgement. Configs are real Claude Code agents in [`.claude/agents/`](../.claude/agents/); this doc is the human-readable map of who owns what.

| Agent | Owns | Gates (review trigger) | Config |
|-------|------|------------------------|--------|
| **Architect** | Data model + module boundaries + 3D geometry math | Changes to interfaces/types in `src/lib/**`, the stage-handoff shapes in [architecture.md](architecture.md), packing math | [`.claude/agents/architect.md`](../.claude/agents/architect.md) |
| **Security** | File-upload handling, third-party API keys, admin config writes, env | Anything touching `file.validator.ts`, OCR/Maps keys, `src/config/env.ts`, admin writes | [`.claude/agents/security.md`](../.claude/agents/security.md) |
| **Design** | UI/UX consistency | Upload/preview UI, admin panel, the 3D viewer (`src/app/**`) | [`.claude/agents/design.md`](../.claude/agents/design.md) |

## Scope discipline
- Each agent reviews **only** changes in its lane. A change spanning lanes gets each relevant agent, separately.
- Agents are read-mostly: they review and report; they don't silently rewrite outside their scope.
- The names here, in `CLAUDE.md §3`, and the filenames in `.claude/agents/` must stay in lockstep: **Architect / Design / Security**.
