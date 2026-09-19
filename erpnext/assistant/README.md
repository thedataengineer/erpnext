# Assistant

Conversation as the front door to the ERP, CRM first. Press **⌘K / Ctrl+K** anywhere in the desk:

- **Search anything.** Records (leads, opportunities, customers, contacts, quotations, projects, tasks,
  invoices) as you type, only what you may read, with type-ahead (Tab completes).
- **Do anything.** "New lead", "Log a call", "Follow up", "New opportunity", "Pipeline", or a whole
  sentence: *"just spoke to Acme, they want a proposal by friday"*. It becomes a draft card under the box.
  Nothing is saved until you press **Create**.
- **Talk instead of typing.** The mic button dictates into the box (see *Voice*).
- **Knows where you are.** On a lead's page, "log a call" means *that* lead.

The round button bottom-right also opens the bar, and `Alt+J` opens the same conversation as a chat panel.
Everything, including the language model, runs on this machine ([Ollama](https://ollama.com)).

> Frappe already binds ⌘K/Ctrl+K to its own awesomebar. The bar takes that shortcut over (capture phase);
> Frappe's search stays on **Ctrl+G**. Rich-text editors keep ⌘K for "insert link".

## How it works

The model does two small jobs: work out what the person wants (`engine.classify`) and pull a few fields out
of the sentence (`engine.extract`). Everything else is plain code, so it is fast and checkable.

| Step | Where |
| --- | --- |
| dates ("last friday", "end of month"), durations ("90 min"), amounts ("20k") | `parsing.py`: models are unreliable at this, so code decides |
| email and phone, taken from the sentence, not from the model | `Field.pattern` in `recipes.py`, applied in `engine._backstop` |
| matching "Acme" to a real lead/customer/opportunity | `engine.match_candidate` (ignores "Corp"/"Inc" and the kind tag) |
| defaults, permission check, dry-run validation | `engine.evaluate` (saves inside a savepoint, then rolls back) |
| what to ask next, chips, wording of every reply | `engine.compose` |
| well-known questions ("how's my pipeline") | `engine.QUERY_CUES`: answered without the model |
| search and suggested actions | `search.py`, over the record registry in `records.py` |

The model never writes anything. It only fills a draft; the person confirms, and the document is saved as
the logged-in user, so their permissions apply exactly as in the full form. The engine is stateless: the
client sends back the `state` it received and the server re-validates everything in it on every turn.

## Recipes

`recipes.py` lists the compact forms.

| Recipe | Creates |
| --- | --- |
| `create_lead` | Lead (a person, a company or an email is enough) |
| `log_note` | a Comment on any lead, customer, prospect or opportunity |
| `create_opportunity` | Opportunity for a lead, customer or prospect, with value and closing date |
| `follow_up` | a ToDo for you, optionally linked to a record |
| `log_time`, `create_task`, `create_project`, `create_customer` | Timesheet, Task, Project, Customer |

To add one: a `Recipe` (its few friendly `Field`s, a `build` function returning the real document, a `done`
sentence), and a line in the classifier prompt in `engine._classify_prompt`. A link that can point at several
kinds of record uses `link_doctypes=(...)`; `context=True` defaults it to the record being viewed.
`records.py` says how each kind of record is titled and searched.

## Voice

The mic uses the browser's own speech recognition. **In Chrome and Safari that can send the audio to the
browser vendor's service**, so the bar says so while it listens; nothing else leaves the machine. Words
appear and search as you speak, and you still press Enter. Where the browser has no speech recognition the
mic is hidden. A fully local option (e.g. whisper.cpp) would need an extra server.

## Configuration (site config, all optional)

| Key | Default |
| --- | --- |
| `assistant_llm_url` | `http://127.0.0.1:11434` |
| `assistant_llm_model` | best installed of `qwen3:14b`, `qwen3:8b`, `gemma4-e2b`, else the first installed |

```bash
ollama pull qwen3:14b
bench --site <site> set-config assistant_llm_model qwen3:14b
```

### Sharing Ollama with other tools

Editors and agents (Zed, Cursor, …) often use the same Ollama server and can keep a big model busy for a
minute or more. Unless `assistant_llm_model` is set, the best model gets a short first try and a faster one
takes over if it is busy (`llm.chat_json`). Two more things to know:

- Ollama reloads a model when a request asks for a different context size, and its default (40k) needs
  ~6 GB more memory than the assistant's (`llm.NUM_CTX = 4096`). Anything that warms the model up should
  use the same `num_ctx` (the one-click start script does).
- On a 24 GB Mac, a 14B model plus Docker plus an editor can push the machine into swap. `qwen3:8b` or
  `gemma4-e2b` are much lighter.

## Tests

`test_assistant.py` and `test_crm.py` replace the model with a scripted fake, so the whole conversation
logic is tested without one. They run in a transaction that is rolled back and deliberately do not use
`ERPNextTestSuite` (importing `erpnext.tests.utils` bootstraps and commits a lot of test data into whatever
site it runs on).

```bash
bench --site <test-site> run-tests --module erpnext.assistant.test_assistant
bench --site <test-site> run-tests --module erpnext.assistant.test_crm
```
