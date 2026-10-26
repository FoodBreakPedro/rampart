# Job: schedule — a weekly sync and the overdue L1 audits

`/rampart schedule [--weekly | --off]` creates or removes one weekly job on this machine. Each Monday at 09:00 local time it runs `/rampart schedule --run`: the live dashboard's sync, then audit L1 on every system whose L1 is overdue. It uses whatever scheduler the host offers: the scheduled-tasks tools, else `CronCreate`, else a cron line the user installs.

## Arguments

- `--weekly`, or no flag: create the weekly job, by Weekly below.
- `--off`: remove it, by Off below.
- `--run`: what the weekly job runs, by Run below. It is meant for the scheduler; a person may type it to run one pass now.

## Rules

- The schedule's id lives in `config.json` and changes only through `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard-set --schedule-id <id>` or `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard-set --clear schedule-id`; never edit it by hand. The id names its scheduler: `scheduled-tasks:<taskId>`, `cron:<id>` or `crontab:rampart-weekly`.
- A scheduled job is persistent: it keeps running after this conversation ends. It is created only after the user said yes in this conversation.
- A tool listed as deferred is loaded with ToolSearch first. Rampart never edits a crontab, a settings file or a hook.

## Weekly

1. **Already scheduled?** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard --json`. When `scheduleId` is not null, say a weekly job is already scheduled (name the id) and that `/rampart schedule --off` removes it. Stop.
2. **Ask.** AskUserQuestion, `header: "Schedule"`, `question: "Create a weekly Rampart job, Mondays at 09:00 local time? It syncs the live dashboard, then runs audit L1 on every system whose L1 is overdue, until /rampart schedule --off removes it."`, options "Yes, schedule it" and "No". "No" or no answer: nothing is created; say so and stop.
3. **Create it** with the first scheduler the host offers:
   1. **Scheduled tasks.** When `mcp__scheduled-tasks__create_scheduled_task` is available: call it with `taskId: "rampart-weekly"`, `title: "Rampart weekly"`, `description: "Rampart: sync the live dashboard, then audit L1 where it is overdue"`, `cronExpression: "0 9 * * 1"` and `prompt: "/rampart schedule --run"`. A refusal because the id is in use names a free one (`rampart-weekly-2`): call once more with that id. `<taskId>` is the id that was accepted. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard-set --schedule-id scheduled-tasks:<taskId>`. Tell the user the job runs while the app is open, and a run missed while it was closed runs at the next launch.
   2. **CronCreate.** Otherwise, when `CronCreate` is available: call it with the cron expression `0 9 * * 1`, the prompt `/rampart schedule --run`, recurring, and durable when the tool offers that. `<id>` is the job id it returns. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard-set --schedule-id cron:<id>`. When the result says the job lasts only as long as this session, say so.
   3. **A cron line.** Otherwise, print this line for the user's own crontab, and say Rampart did not install it (`claude` may need its full path under cron):

      ```
      0 9 * * 1 claude -p "/rampart schedule --run" --permission-mode auto
      ```

      Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard-set --schedule-id crontab:rampart-weekly`, so `--off` can remind them to remove it.

   A scheduler that refuses: relay its reason in one line and try the next. When `dashboard-set` refuses the id, say the job was created with that id and that `--off` cannot find it by itself.
4. **Say** in one line what was scheduled, by which scheduler, and when it first runs.

## Off

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard --json`. `scheduleId` null: say nothing is scheduled from this machine, and stop.
2. Remove it with the scheduler its id names:
   - `scheduled-tasks:<taskId>`: `mcp__scheduled-tasks__delete_scheduled_task` with `taskId` `<taskId>`.
   - `cron:<id>`: `CronDelete` with that id.
   - `crontab:rampart-weekly`: ask the user to remove the `/rampart schedule --run` line with `crontab -e`; Rampart does not edit it.

   When the tool is not available here, or says the task does not exist, the job is gone already or cannot be reached from this session: say which, and go on.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard-set --clear schedule-id`, then say the weekly job is off.

## Run

The weekly job, unattended: nobody is at the terminal. Ask nothing; give any question a recipe asks its no-cost answer (secrets triage: "No, leave them untriaged"). Every gate a recipe applies still applies.

1. **Sync.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" dashboard --json`. When `url` is not null, sync every project as `/rampart dashboard --sync` does, by the Sync section of [dashboard](${CLAUDE_SKILL_DIR}/jobs/dashboard.md). With no dashboard, note that the sync was skipped. A sync that fails is a note, never the end of the run.
2. **Projects.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/store.cjs" projects`. None: say nothing is inventoried yet, and stop.
3. **Overdue.** For each project `<slug>`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/score.cjs" <slug> --json --no-save`. A system is overdue when its `layers.L1` exists and its `nextDue` is null (L1 never ran) or earlier than the output's `at`. A system with no L1 layer is not audited here. A project the score refuses (non-zero exit) is noted and skipped.
4. **Audit.** For each overdue system, one at a time: `/rampart audit L1 --project <slug> --system <id>`, by the L1 section of [audit](${CLAUDE_SKILL_DIR}/jobs/audit.md), including its own sync at the end.
5. **Summary.** One line per project, counts only: systems audited, overdue systems skipped and why, and the grade and score after. Nothing overdue anywhere: "Nothing overdue; the dashboard is synced."
