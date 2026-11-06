# Isolated skill comparison: `accordion-task-lists`

## Result

Both arms produced a valid task list in 3/3 cases, so the skill did **not** improve validity here. With the skill the agent loaded it in every run and wrote more compact lists: 7 tasks versus 19 for the transcript plan and 7 versus 12 for invoices. The repair case was 1 task in both arms. Every leaf had one to three acceptance criteria in both arms, and every list had a goal. The sample (one run per case and arm) cannot show that compactness is better, nor that the skill improves quality. Keep the skill because it ships the validator and schema reference; this comparison gives no stronger claim.

## Setup

Three synthetic prompts (convert a plan, write from scratch, repair an invalid file), one run each with and without the skill, `deepseek-flash`, thinking off. The agent had Pi's `read`, `write` and `bash` tools inside a restricted mount namespace; its shell ran in a nested PID, mount and network namespace whose only writable path was the fixture. Both arms received the JSON Schema file; only the skill arm received the skill, its validator and `taskSchema.ts`. A host-side proxy injected the credential and capped spending at $0.60. Total estimated cost was about $0.019 from provider-reported usage, not an invoice.

Before any provider call, a local mock drove both arms through reads of host paths, a shell probe and the Pi jiti cache. The host paths and cache were absent, the baseline saw only `/work/reference`, and the skill arm additionally saw `/work/extension`. The earlier unsandboxed baseline is excluded: it read repository files and found the skill.

## Limits

Validity was graded by the skill's own validator, so it favours the skill arm's feedback loop; the baseline could not run it. Single runs per cell. Scripts are captured with machine-specific paths.
