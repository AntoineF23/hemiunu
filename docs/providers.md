# Provider matrix

The engine is provider-neutral: any model registry entry (shipped defaults
merged with `~/.hemiunu/models.json`) can drive a whole turn — the loop, the
permission pipeline, delegation, MCP tools, transcript and compaction are the
same code for every provider. This page records what was actually **tested
live**, one run per model, on the P7 hardening pass (July 2026).

Two suites:

- **Smoke** (`pnpm smoke --model <id>`) — 39 offline structural checks + 4 live
  checks: a real turn (PONG), persona wiring ("identifies as Hemiunu"),
  researcher delegation grounded in a file over MCP, and the `ask_model` tool.
- **Capability S1–S11** (`pnpm cap --model <id>`) — 11 live scenario evals
  (grounding, no-fabrication, memory routing, wireframe generation, proactive
  note-taking, parallel fan-out, knowledge round-trip, resume).

## Results

| Model (registry id) | Route | Smoke | Notes |
| --- | --- | --- | --- |
| `claude-opus-4.8` | Anthropic direct | **43/43** | Reference model. Cost reported ($0.61 for the run). |
| `gpt-4o` | LiteLLM proxy | **43/43** | Clean tool calling; also ran S1–S11 (below). Cost reported ($0.10). |
| `gemini-2.5-pro` | LiteLLM proxy¹ | **43/43** | Clean delegation + grounding. Proxy stream reports no usage → cost shows $0. |
| `deepseek-v3` | LiteLLM proxy | **43/43** | Clean delegation + grounding. No stream usage → cost $0. |
| `qwen3-235b-instruct` | LiteLLM proxy | **43/43** | Clean delegation + grounding. No stream usage → cost $0. |
| `mistral-medium` | LiteLLM proxy | **42/43** | Persona + PONG pass. The delegation turn died on an **upstream Vertex AI quota** (`429 RESOURCE_EXHAUSTED` for `mistralai-mistral-medium-3`, retried 3× by the AI SDK) — proxy infrastructure, not the model or the engine. |
| `ministral-3:14b` | local Ollama | **41/43 → 42/43²** | See "Ollama context truncation" below — the persona failure was prompt truncation, not model behavior; the remaining miss is a genuine 14B synthesis limitation. |

¹ The shipped `gemini-2.5-pro` default entry is Google-direct (`GEMINI_API_KEY`);
this run used a `models.json` override routing it through the LiteLLM proxy.

² 41/43 with Ollama's default 4096-token context (persona + post-delegation
checks fail); 42/43 once the context is raised (see below): the persona check
passes, the delegation check now delegates and grounds correctly but the final
synthesis was a degenerate one-word answer ("Hemiunu") instead of the grounded
sentence the check requires.

### S1–S11 on a second frontier provider: `gpt-4o` (LiteLLM)

**10/11** — one run, researcher tier also on gpt-4o, cost ~$0.40.

| Scenario | Result |
| --- | --- |
| S1 grounds an answer in a connected source | pass |
| S2 admits ignorance instead of fabricating | pass |
| S3 user fact → `remember` | pass |
| S4 feature fact → `add_prototype_note` | pass |
| S5 mixed facts, no cross-contamination | pass |
| S6 self-contained low-fi wireframe (judge: grayscale ✓ lowfi ✓ 4/5) | pass |
| S7 proactive durable insight to PROTOTYPE.md | pass |
| S8 parallel fan-out via the `parallel` tool | **fail (model-side)** |
| S9 researcher on the research tier (structural) | pass |
| S10 `get_prototype` before `update_prototype` | pass |
| S11 conversation resume recalls context | pass |

**S8 diagnosis** (debug rerun): gpt-4o answered both research questions by
issuing **two `delegate` calls to the researcher** instead of one `parallel`
call with two tasks — both delegations executed and the final synthesis was
correct. The engine's fan-out machinery is exercised and green elsewhere
(offline + S8 on Opus); this is a tool-*selection* preference, the same known
gap the suite documents for Sonnet. Not an engine defect; left as a documented
model-side limitation.

## Ollama context truncation (the ministral 41/43)

The two long-standing ministral failures ("paraphrases its persona instead of
saying Hemiunu", "answers with a follow-up menu after delegation") turned out
to be **silent prompt truncation, not model behavior**. Ollama loads models
with a default context of **4096 tokens** (`OLLAMA_CONTEXT_LENGTH`), while a
Hemiunu turn's system prompt + tool schemas run ~5.5–7.5k tokens. Ollama keeps
the *tail* and drops the *head* — i.e. exactly the "You are Hemiunu…" soul:

```
level=WARN source=runner.go msg="truncating input prompt" limit=4096 prompt=7301 keep=4 new=4096
```

With the head gone, the model can't know its name, drifts language, and loses
the delegation guidance. Fix either side:

- server: `OLLAMA_CONTEXT_LENGTH=16384 ollama serve` (or the app's settings), or
- per model: `ollama create ministral-3:14b-16k -f-` with
  `FROM ministral-3:14b` + `PARAMETER num_ctx 16384`, and point the registry
  entry's `model` at it.

Verified live with the 16k derivative (one full run): **42/43**. The persona
check passes ("agent identifies as Hemiunu"), and the delegation check now
does everything right structurally — it delegates to the researcher, the
sub-run grounds itself in the README, the report comes back — but the model's
final synthesis was the single word "Hemiunu" instead of the grounded sentence
the check demands. That last step is a genuine 14B quality limitation (with
truncation it used to answer with a menu of follow-ups; now it answers, just
too tersely), documented here rather than papered over. The `ministral-3:14b`
registry entry ships two `promptHints` (see below) that harden persona
adherence and post-delegation synthesis for this family.

## Family prompt hints (`promptHints`)

`ModelEntry.promptHints` is a list of small, family-scoped system-prompt
addenda. The engine loop appends them after the caller's system prompt on
every turn (main and subagent alike) — quirks of a weaker family are corrected
*without* forking the soul per model. The shipped `ministral-3:14b` entry uses
it for persona adherence and post-delegation synthesis; add your own via
`~/.hemiunu/models.json`.

## Weak-model tool-repair ladder

The permission pipeline self-repairs the failure shapes weak models produce,
all under the same 3-attempt cap as malformed-args repair:

1. **Invented tool names** — case/punctuation drift and unambiguous bare MCP
   names (`search` for `mcp__acme__search`) are corrected in place once per
   misspelling; near-misses get a `Did you mean '…'?` self-repair error.
2. **Stringified-JSON arguments** — double-encoded inputs are parsed back into
   the object the model meant; an undecodable string gets a targeted error.
3. **Empty/missing required fields** — a required field that is absent, null,
   or an empty string produces an error naming exactly the field(s) to fill.

## Tool-call / tool-result balancing

Strict providers reject an unbalanced history — Vertex/Gemini (reached through
the LiteLLM proxy for `openai-compatible` entries like `deepseek-v3`) returns
`400 "No tool calls but found tool output"` for a tool output that isn't
preceded by the assistant tool-call it answers, and also rejects a tool-call
that never gets a result. Since a durable transcript can hold either imbalance
(a proxied step whose streamed tool-calls didn't survive into the persisted
assistant message, or a crash between the assistant and tool appends), the
engine now guards both ends: the loop reconciles the persisted assistant
message against the stream's authoritative tool-calls (`ensureAssistantToolCalls`)
so an orphan is never written, and `balanceToolMessages` repairs the wire view
before **every** provider call — dropping orphaned tool outputs and dangling
tool-calls. This is provider-neutral (a no-op on an already-balanced Anthropic
history) and also un-wedges a conversation that already stored an orphan.

## Cost reporting

`costUsd` prices a turn from the entry's `cost` table (per-Mtok). The LiteLLM
defaults (`gpt-4o`, `deepseek-v3`, `qwen3-235b-instruct`, `mistral-medium`)
ship the providers' published list prices, so proxy turns no longer report $0
— **when the proxy returns usage**. For some upstreams (gemini, deepseek, qwen
in this run) the LiteLLM stream carried no usage numbers, so those turns still
show $0; the proxy's own `x-litellm-response-cost` header remains the source
of truth for billing.
