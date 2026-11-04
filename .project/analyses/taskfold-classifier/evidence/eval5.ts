// Classifier shape experiment: goal-aware state plus several question shapes in one request.
const MODELS = (process.env.CLF_MODELS ?? "perplexity/pplx-decider-v1.2,perplexity/pplx-decider-flash-v1.2,liquid/d1-ultra,openai/gpt-6-luna-decisions,typesafe/jev-1.14").split(",");
const LIMIT = Number(process.env.CLF_LIMIT ?? 1e9);
const OUT = process.env.CLF_OUT ?? "/tmp/clf-eval/results4.json";
const ITEMS = process.env.CLF_ITEMS ?? "/tmp/clf-eval/items4.json";

const OLD7 = { type: "choice", instructions: "A message sent to a coding assistant in the user role during a task. What does it do?", criteria: {
  "new-task": "Starts a new task or changes what the assistant should be working on.",
  "new-instruction": "A new instruction or requirement that must hold for the rest of the session.",
  constraint: "Adds or restates a limit on the current task (what to avoid, keep or prefer).",
  steering: "Corrects or redirects how the current task is being done, without changing the task.",
  info: "Supplies extra information, context or an answer the assistant asked for.",
  ack: "Acknowledges, approves, thanks or tells the assistant to continue.",
  harness: "Automated text from a tool, harness or system, not written by a person." } };
const KEEP_OLD = { type: "bool", instructions: "A message sent to a coding assistant in the user role, in the middle of a session. Does it start new work or set a requirement that must keep holding later? Answer false if it only reacts to the current work: approves, thanks, says continue, corrects or narrows the current step, answers a question, reports status, or is automated harness text.", criteria: { true: "Starts a new task, asks a new question, or sets a lasting rule or decision the assistant must remember.", false: "Only reacts to or adjusts the work already in progress, or is automated text." } };

const CTX = "`message` is the newest user-role message in a coding-agent session. `session_goal` is the session's first user message, `previous_user_message` the user-role message before `message` (empty when it is `session_goal`), and `assistant_last_reply` the end of the assistant's reply that `message` answers. User-role messages come from the human, from a coordinating parent agent, or from the harness.";
const NEW = {
  keep_goal: { type: "bool", instructions: `${CTX} Once the work in progress is finished, its transcript is replaced by a short summary of what was done. Must the text of \`message\` itself stay visible so the assistant can continue correctly? It must when \`message\` asks for work or an answer that nobody requested before it: a new task, an additional deliverable, a new question about the subject, or a new direction for \`session_goal\`. A go-ahead for something \`assistant_last_reply\` proposed is not new work; neither is a retry notice, a question whether requested work is done, or information the assistant asked for.`, criteria: { true: "`message` asks for a task, deliverable, direction or answer that was not requested or proposed before it.", false: "`message` approves, continues, reports on, checks the status of, or adjusts work that was already requested or proposed." } },
  new_work: { type: "bool", instructions: `${CTX} Does \`message\` ask the assistant for work or an answer that neither \`session_goal\`, \`previous_user_message\` nor \`assistant_last_reply\` already requested or proposed? Approving a proposal from \`assistant_last_reply\` is not new work; asking to also do something the proposal left out is.`, criteria: { true: "`message` requests a task, deliverable or answer that was not requested or proposed before.", false: "Everything `message` asks for was already requested by the user or proposed by the assistant." } },
  durable_rule: { type: "bool", instructions: `${CTX} Does \`message\` set a rule, constraint, preference or decision about the work that must keep holding after the current step is finished? Lasting content includes a prohibition, a priority order, a chosen option, an interface contract or a naming rule. An instruction about the current step only, such as finishing now or reporting when done, is not lasting.`, criteria: { true: "`message` states a rule, constraint, preference or decision that keeps applying to later work.", false: "`message` concerns only the current step, or states no rule at all." } },
  overrule: { type: "bool", instructions: `${CTX} Does \`message\` reverse, replace or correct an earlier instruction, decision, assumption or result from the user or the assistant?`, criteria: { true: "`message` replaces or corrects something said or done earlier.", false: "`message` builds on what was said and done earlier without changing it." } },
  approval_only: { type: "bool", instructions: `${CTX} Is \`message\` only a go-ahead, approval, thanks or request to continue, with no requirement or information of its own?`, criteria: { true: "`message` only approves or tells the assistant to go on.", false: "`message` contains a request, requirement, question or information of its own." } },
  status_check: { type: "bool", instructions: `${CTX} Is \`message\` only asking whether work that was already requested has been completed, committed, pushed, saved or verified?`, criteria: { true: "`message` asks about the state of earlier requested work and nothing else.", false: "`message` asks for work, information or decisions beyond the state of earlier work." } },
  automated: { type: "bool", instructions: `${CTX} Is \`message\` an automated harness notice, such as a provider error followed by an instruction to continue, rather than text written by a person or a coordinating agent?`, criteria: { true: "The harness generated `message` automatically.", false: "A person or a coordinating agent wrote `message`." } },
  info_only: { type: "bool", instructions: `${CTX} Does \`message\` only supply facts about the work, such as test results, measurements, evidence or what another agent did, without asking for anything new?`, criteria: { true: "`message` reports facts and asks for nothing new.", false: "`message` asks for work, an answer or a change." } },
  goal_shift: { type: "bool", instructions: `${CTX} Does \`message\` change what the session is trying to achieve compared with \`session_goal\`: a different objective, a new topic or a major change of scope?`, criteria: { true: "`message` sets a different objective, topic or scope than `session_goal`.", false: "`message` keeps working toward `session_goal` as stated." } },
  act: { type: "choice", instructions: `${CTX} What is the main role of \`message\` for the work toward \`session_goal\`?`, criteria: {
    new_task: "Starts a task, topic or deliverable that was not requested before.",
    scope_addition: "Adds work, a deliverable or a requirement to the task in progress.",
    subject_question: "Asks a question about the subject that the assistant must answer.",
    lasting_rule: "Sets a rule, constraint or preference that keeps applying after the current step.",
    decision: "Chooses between options the assistant offered or settles a design question.",
    correction: "Reverses or corrects an earlier instruction, assumption or result.",
    step_steering: "Tells the assistant how to wrap up the current step: hurry, narrow, stop, wait or report.",
    supplied_facts: "Supplies evidence, results or context without asking for new work.",
    go_ahead: "Approves a proposal or tells the assistant to continue, adding nothing.",
    status_check: "Asks whether earlier requested work is done, committed or pushed.",
    harness_notice: "An automated error or retry notice from the harness." } },
  fate: { type: "choice", instructions: `${CTX} When the finished part of the session is replaced by a short summary of what was done, what must remain of \`message\` for the assistant to continue correctly?`, criteria: {
    keep_verbatim: "Its exact text, because it defines work or a question that is new or still open.",
    keep_as_rule: "Only a lasting rule, constraint or decision it states, not its wording.",
    drop: "Nothing: it is an approval, status check, retry notice, step instruction, or facts the finished work already used." } },
  keep_v2: { type: "bool", instructions: `${CTX} Completed work is later replaced by a short summary of what was done. Should \`message\` stay visible after that? Keep it when it opens or redirects a unit of work (a new task, a new question, a separate deliverable, a newly reported bug) or states a rule, decision, preference or fact that must keep holding. Drop it when it only steers the work already under way: a go-ahead or authorization of what \`assistant_last_reply\` proposed, a commit, push or merge request, a question whether work is done or a complaint that it is not, a small tweak or correction to the current deliverable, facts the current step consumes, or an automated notice.`, criteria: { true: "`message` opens or redirects work, or states something that must keep holding.", false: "`message` only steers, approves, checks on or feeds the work already under way." } },
  loss: { type: "score", instructions: `${CTX} How much would the assistant's later work suffer if it could no longer see \`message\` once the work in progress is summarized?`, criteria: [
    "Nothing is lost: `message` is an approval, retry notice, status check or instruction about the current step.",
    "A detail is lost that a summary of the finished work would already contain.",
    "A lasting rule, decision or correction is lost that the assistant must keep following.",
    "The task or question itself is lost, so the assistant would not know what it was asked to do." ] },
};

export default function (pi: any) {
  pi.on("session_start", async (_e: any, ctx: any) => {
    const fs = require("node:fs"); const r = ctx.modelRegistry;
    const items = JSON.parse(fs.readFileSync(ITEMS, "utf8")).slice(0, LIMIT);
    const out: any[] = [];
    await Promise.all(MODELS.flatMap((id) => (process.env.CLF_VARIANTS ?? "bare,goal").split(",").map(async (variant) => {
      const m = r.findOfType("classifier", "openrouter", id);
      if (!m) { out.push({ model: id, variant, err: "model not found" }); return; }
      let i = 0;
      const worker = async () => { while (i < items.length) { const x = items[i++]; const t = Date.now();
        const state = variant === "bare" && false ? null : variant === "bare" ? { message: x.text } : { session_goal: x.goal, previous_user_message: x.prev_user, assistant_last_reply: x.prev_asst, message: x.text };
        const QSETS: Record<string, string[]> = { c_act: ["act", "fate", "loss"], c_keep: ["keep_goal", "durable_rule", "overrule", "loss"] };
        const questions = QSETS[variant] ? Object.fromEntries(QSETS[variant].map((q) => [q, (NEW as any)[q]])) : variant === "loss" ? { loss: NEW.loss } : variant === "keep_v2" ? { keep_v2: NEW.keep_v2 } : variant === "bare" ? { old7: OLD7, keep_old: KEEP_OLD } : { old7: OLD7, keep_old: KEEP_OLD, ...NEW };
        let res: any;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { res = await r.classify(m, { state, questions }); } catch (e: any) { res = { errorMessage: String(e?.message ?? e) }; }
          if (!res.errorMessage) break;
          await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
        }
        out.push({ model: id, variant, id: x.id, split: x.split, gold: x.gold, answers: res.answers ?? null, err: res.errorMessage, cost: res.usage?.cost?.total, inTok: res.usage?.input, ms: Date.now() - t });
      } };
      await Promise.all([worker(), worker(), worker(), worker()]);
    })));
    fs.writeFileSync(OUT, JSON.stringify(out));
  });
}
