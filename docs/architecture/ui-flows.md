# UI Flows

Three flows that used to be the most regression-prone in Switchboard:
images through the chat, AskUserQuestion / ExitPlanMode rendering, and
the archive filter. This file is the written form of the mental model
that took us 2 sessions of debugging to build.

## 1. Image pipeline (send + reload)

### Send path

```
ChatInput (paste/drop/ /image)
  └─ ImageAttachment[] (File + previewUrl)
      └─ ChatPanel.handleSend
           └─ FileReader.readAsDataURL → MessageImage[] (url=data:image/…;base64,…)
                ├─ appendMessage to store (renders locally)
                ├─ window.api.app.saveMessage(..., images: JSON.stringify(messageImages))  [DB row]
                └─ window.api.provider.sendTurn(sessionId, message, runtimeMode, messageImages)
                     └─ IPC: ProviderChannels.SEND_TURN
                          └─ ProviderRegistry handler
                               └─ adapter.sendTurn(threadId, message, mode, images)
                                    └─ ClaudeAdapter strips `data:image/png;base64,` prefix
                                         └─ SDK MessageParam { content: [image blocks..., text block] }
```

**Historical gap (fixed 2026-04-20):** `sendTurn` signatures dropped the
`images` param at every layer between ChatPanel and claude-adapter.
Images showed locally but never reached the SDK.

### Reload path (app restart)

```
User clicks session in sidebar
  └─ handleSessionSelect(session, projectPath)
       └─ window.api.app.loadSession(session.filePath, session.id, session.source)
            └─ LOAD_SESSION IPC reads the JSONL file
                 └─ new JsonlParser(onMessage, source)
                      └─ normalizeEvent for each line
                           └─ Claude user event → extractContent() + extractImages()
                                └─ MessageImage[] reconstructed from `image` blocks
```

**Historical gap (fixed 2026-04-20):** `JsonlParser.extractContent` only
pulled text blocks; image content blocks were silently dropped.
Historical images vanished after app restart even though the JSONL had
them.

## 2. Question + Plan flows

Both tools share a pattern: the agent calls a tool, we intercept in
`canUseTool`, render a custom card, and resolve the tool call based on
user interaction.

### AskUserQuestion → QuestionCard

```
Agent emits tool_use block: { type:'tool_use', name:'AskUserQuestion', input:{ questions: [...] } }
  ├─ claude-adapter.handleSDKMessage: tool_use loop
  │    └─ if CUSTOM_UI_TOOLS.has(block.name) continue  // SUPPRESS tool.started
  └─ SDK calls canUseTool('AskUserQuestion', toolInput)
       └─ parseQuestions(toolInput) → Question[]
       └─ emit RuntimeEvent { type: 'question.asked', threadId, requestId, questions }
       └─ await new Promise → stored in active.pendingQuestions[requestId]

[renderer receives event]
ChatPanel's provider.onEvent switch:
  case 'question.asked': appendMessage({ id: `question_${requestId}`, question: {...} })

MessageList.groupIntoTurns KEEPS this message (has .question attachment) [critical keeper-list check]
MessageBubble sees message.question → renders <QuestionCard>

[user picks options]
QuestionCard calls onAnswer(answers: string[][])
  └─ ChatPanel.handleAnswerQuestion(requestId, answers)
       └─ window.api.provider.answerQuestion(sessionId, requestId, answers)
            └─ IPC: ProviderChannels.ANSWER_QUESTION
                 └─ adapter.answerQuestion(threadId, requestId, answers)
                      └─ active.pendingQuestions.get(requestId).resolve(answers)
                           [unblocks the Promise in canUseTool above]
                           └─ canUseTool returns { behavior:'allow', updatedInput: {..., __user_answers: formatted} }
                                └─ tool call "completes" with user's answers as output
                                     └─ agent gets the answers in its next turn
```

### ExitPlanMode → PlanCard

Same pattern as above but simpler: no Promise blocking, we just deny the
tool and remember the plan. A subsequent "Implement Plan" click sends a
new user turn asking the agent to proceed.

```
Agent emits tool_use: { name: 'ExitPlanMode', input: { plan: markdown } }
  ├─ CUSTOM_UI_TOOLS: suppress tool.started
  └─ canUseTool: extractPlanMarkdown(toolInput)
       └─ emit { type: 'plan.proposed', planId, planMarkdown }
       └─ return { behavior: 'deny', message: "captured your plan, wait for user feedback" }

ChatPanel:
  case 'plan.proposed': appendMessage({ plan: { id, markdown } })

MessageBubble → <PlanCard>
  ├─ Implement Plan button → onPlanAction(planId, 'implement')
  │    └─ handlePlanAction sends new user turn "Proceed with the plan" + switches mode to sandbox
  └─ Iterate button → focuses chat input for user to write feedback
```

### Critical keeper list in MessageList

Any message with only a custom-UI attachment has `content === ''`. The
pre-2026-04-20 filter in `groupIntoTurns` dropped messages with empty
content unless they had `toolCalls` or `approval`. This silently hid
QuestionCard / PlanCard / image-only / denial-only messages. The current
keeper-list is:

```ts
if (!msg.content
    && !msg.toolCalls?.length
    && !msg.approval
    && !msg.question
    && !msg.plan
    && !msg.images?.length
    && !msg.denial
) continue  // skip — truly empty
```

Adding a new attachment type? You must add it here too, or it'll render
correctly mid-session but disappear on app restart / tab switch.

## 3. Archive filter

### Write path (archiving a chat)

```
User clicks archive button on a sidebar thread
  └─ Sidebar.handleArchive(projectPath, session)
       ├─ optimistic: remove from UI
       └─ window.api.app.archiveConversation(session.id, projectPath, session.title)
            └─ ARCHIVE_CONVERSATION IPC
                 ├─ ensureConversation(id, projectPath, 'claude-code', title)  // INSERT OR IGNORE
                 └─ archiveConversation(id)                                    // UPDATE ... SET archived = 1
                 └─ verify via isConversationArchived(id)  // returns boolean
```

### Read path (loading sidebar on restart)

```
Sidebar mounts
  └─ window.api.app.getProjects()
       └─ GET_PROJECTS IPC
            ├─ getProjects() → rows from projects table
            ├─ getArchivedConversationIds() → global Set<id>  [2026-04-20: global, not per-project]
            └─ for each project:
                 ├─ sessions = scanAllSessions(row.path)
                 │    └─ scanClaudeCodeSessions: exact-match dir filter (not substring)
                 │    └─ scanCodexSessions: scan ~/.codex with CWD substring match
                 ├─ dbConversations = getConversationsForProject(row.path)  [for titles only]
                 ├─ titleMap = map of DB titles
                 └─ filtered = sessions
                      .filter(s => !archivedSet.has(s.id))  // GLOBAL filter
                      .map(s => ({ ...s, title: titleMap.get(s.id) ?? s.title }))
```

### Two pre-2026-04-20 bugs fixed here

1. **Scanner substring bleed**: `dir.includes(encoded)` caused the parent
   project `/Users/foo/ssg` to match child project dirs like
   `-Users-foo-ssg-submodule`. Parent project was listing sessions that
   physically belonged to children. Fixed with exact equality.

2. **Per-project archive filter**: if the same session was visible under
   both parent and child projects (due to bug #1), archiving under one
   didn't hide it under the other, because `getConversationsForProject(path)`
   only returned rows with that exact `project_path`. Fixed with
   `getArchivedConversationIds()` returning a global set.

## 4. Build gate execution order

```
npm run build
  ├─ prebuild lifecycle (npm auto-runs this before `build`)
  │    ├─ npm run typecheck
  │    │    ├─ tsc --noEmit -p tsconfig.main.json
  │    │    └─ tsc --noEmit -p tsconfig.renderer.json
  │    └─ npm test
  │         └─ vitest run → ~190 tests across 18 files
  └─ electron-vite build
       ├─ main bundle → out/main/index.js
       ├─ preload bundle → out/preload/index.js
       └─ renderer bundle → out/renderer/*
```

Fail-fast: if typecheck or tests fail, `prebuild` returns non-zero and
the main build step never runs. Escape hatch is `npm run build:fast`
which bypasses the gate (for iterative local use only; CI always uses
the gated path).
