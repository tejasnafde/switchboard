# README positioning design

## Goal

Make the repository landing page explain what Switchboard does today, who it
is for, and why it is distinct without claiming unshipped capability.

## Positioning

Switchboard is an open-source command center for AI agents and the local
development environment around them. It currently supports Claude Code,
Codex, and OpenCode. The provider adapter model is intentionally extensible;
Cursor and other providers are planned, but no delivery date is promised.

## Reader and desired action

The primary reader is a developer already using one or more coding agents
alongside terminals, repositories, and local or remote services. The desired
action is to download a release or clone the repository to try Switchboard.

## README structure

1. A concise hero that states the category, present providers, and outcome.
2. A problem statement describing disconnected agents, terminals, files, and
   worktrees.
3. A workflow-led summary of current capabilities, emphasizing the context
   bridge, parallel worktrees, history/diff review, and remote machines.
4. A current-provider and future-provider section that invites contributions
   without treating planned integrations as shipped.
5. Focused use cases and an honest alternatives table.
6. Install, development, and deeper technical documentation.
7. The detailed feature tour retained below the decision-making content.

## Constraints

- Do not describe Switchboard as a complete session-restoration product.
- Do not imply Cursor support exists today.
- Avoid empty category language and unsupported competitive claims.
- Prefer direct technical language over marketing idioms, em dashes, and
  generic AI-writing patterns.
