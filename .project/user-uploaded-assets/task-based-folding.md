

If the agent has a task list like this:
```
tasks-list-1:
  task-1:
    sub-task-1:
      sub-sub-task-1:
  task-2:
    sub-task-1:
      sub-sub-task-1:
    sub-task-2:
      sub-sub-task-1:
```

and he does something like:
1. start task-1
2. start sub-task-1
3. start sub-sub-task-1
4. works/turns
5. complete sub-sub-task-1

We will have a transcript similar to this
```
system: Static System Instructions
user: Complete all tasks from `tasks-list-1` completely
agent(tool): tasks list tasks-list-1
tool_result(tasks): result
agent(text): Ok, I have the tasks list, let's start
agent(tool): tasks claim tasks-list-1
tool_result(tasks): result
agent(tool): tasks start task-1
tool_result(tasks): result
agent(tool): tasks start sub-task-1
tool_result(tasks): result
agent(tool): tasks start sub-sub-task-1
tool_result(tasks): result
agent: works
agent: works
agent: works
...
agent(tool): tasks complete sub-sub-task-1
tool_result(tasks): result
```

We could then logically branch the session like:

```
session:
  system  
  user
  agent
  task-list-1
    task-1
      sub-task-1
        sub-sub-task-1
```

We could then **fold** `sub-sub-task-1`/this part:
```
agent(tool): tasks start sub-sub-task-1
tool_result(tasks): result
agent: works
agent: works
agent: works
...
agent(tool): tasks complete sub-sub-task-1
tool_result(tasks): result
```
into a report/summary/compacted variant that only keeps what is needed which would then look like

```
system: Static System Instructions
user: Complete all tasks from `tasks-list-1` completely
agent(tool): tasks list tasks-list-1
tool_result(tasks): result
agent(text): Ok, I have the tasks list, let's start
agent(tool): tasks claim tasks-list-1
tool_result(tasks): result
agent(tool): tasks start task-1
tool_result(tasks): result
agent(tool): tasks start sub-task-1
tool_result(tasks): result
agent(tool): tasks start sub-sub-task-1
tool_result(tasks): result
branch_summary: sub-sub-task-1
agent(tool): tasks complete sub-sub-task-1
tool_result(tasks): result
```

and the agent would continue on this level:
```
session:
  system  
  user
  agent
  task-list-1
    task-1
      sub-task-1
        [folded] sub-sub-task-1
      # here the agent would continue and only sees: start task + task summary + complete task of sub-sub-task-1
```

when he then completes `sub-task-1` it would be folded again like


```
session:
  system  
  user
  agent
  task-list-1
    task-1
      [folded] sub-task-1
        [folded] sub-sub-task-1
    # here the agent would continue
```

eventually this would work too which would be more cache friendly:

```
system: Static System Instructions
user: Complete all tasks from `tasks-list-1` completely
agent(tool): tasks list tasks-list-1
tool_result(tasks): result
agent(text): Ok, I have the tasks list, let's start
agent(tool): tasks claim tasks-list-1
tool_result(tasks): result
agent(tool): tasks start task-1
tool_result(tasks): result
agent(tool): tasks start sub-task-1
tool_result(tasks): result
branch_summary: sub-sub-task-1 # so the summary also replaces the start and complete tool calls

```
