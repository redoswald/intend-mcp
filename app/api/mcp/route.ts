import { z } from "zod";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createClient, getUserId } from "@/lib/supabase";
import { getNextOccurrence, describeRecurrence } from "@/lib/recurrence";

/* eslint-disable @typescript-eslint/no-explicit-any */

function todayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

const handler = createMcpHandler(
  (server) => {
    const supabase = createClient();
    const userId = getUserId();

    // ─── get_tasks ──────────────────────────────────────────────
    server.tool(
      "get_tasks",
      "List tasks from Intend. Filter by inbox, today, upcoming, overdue, project, or status. Use when the user asks about their tasks, what's due, what's in their inbox, or wants to see tasks for a project.",
      {
        view: z.enum(["inbox", "today", "upcoming", "overdue", "all"]).optional()
          .describe("Preset view: inbox (no project), today (due today+overdue), upcoming (due within 14 days), overdue (past due), all (everything open)"),
        project_name: z.string().optional().describe("Filter by project name (fuzzy match)"),
        status: z.enum(["open", "done", "cancelled"]).optional().describe("Filter by status (default: open)"),
        include_completed: z.boolean().optional().describe("Include completed tasks"),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
      async (params) => {
        const limit = Math.min(params.limit || 50, 100);
        const today = todayDateString();
        const status = params.status || "open";

        let query = supabase
          .from("tasks")
          .select("*, project:projects(id, name, color)")
          .eq("owner_id", userId)
          .order("sort_order");

        if (!params.include_completed) {
          query = query.eq("status", status);
        }

        // Apply view filters
        if (params.view === "inbox") {
          query = query.is("project_id", null);
        } else if (params.view === "today") {
          query = query.lte("due_date", today).not("due_date", "is", null);
        } else if (params.view === "overdue") {
          query = query.lt("due_date", today).not("due_date", "is", null);
        } else if (params.view === "upcoming") {
          const twoWeeks = new Date();
          twoWeeks.setDate(twoWeeks.getDate() + 14);
          query = query
            .gte("due_date", today)
            .lte("due_date", twoWeeks.toISOString().split("T")[0])
            .not("due_date", "is", null);
        }

        // Filter by project name
        if (params.project_name) {
          const { data: projects } = await supabase
            .from("projects")
            .select("id, name")
            .eq("owner_id", userId)
            .ilike("name", `%${params.project_name}%`);

          if (!projects || projects.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `No project matching "${params.project_name}"` }) }],
            };
          }

          const projectIds = projects.map((p: any) => p.id);
          query = query.in("project_id", projectIds);
        }

        query = query.limit(limit);

        const { data: tasks, error } = await query;
        if (error) throw new Error(error.message);

        const results = (tasks || []).map((t: any) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          due_date: t.due_date,
          deadline: t.deadline,
          project: t.project?.name || "Inbox",
          project_color: t.project?.color,
          recurrence: t.recurrence_rule ? describeRecurrence(t.recurrence_rule) : null,
          has_subtasks: t.parent_task_id === null,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      }
    );

    // ─── get_task_detail ────────────────────────────────────────
    server.tool(
      "get_task_detail",
      "Get full details about a specific task including subtasks, dependencies, and project context. Use when the user asks about a specific task in depth.",
      {
        task_id: z.string().optional().describe("Task ID"),
        title_search: z.string().optional().describe("Search by title (fuzzy match)"),
      },
      async (params) => {
        let task: any = null;

        if (params.task_id) {
          const { data, error } = await supabase
            .from("tasks")
            .select("*, project:projects(id, name, color)")
            .eq("id", params.task_id)
            .eq("owner_id", userId)
            .single();
          if (error) throw new Error(error.message);
          task = data;
        } else if (params.title_search) {
          const { data: matches, error } = await supabase
            .from("tasks")
            .select("*, project:projects(id, name, color)")
            .eq("owner_id", userId)
            .eq("status", "open")
            .ilike("title", `%${params.title_search}%`)
            .limit(5);
          if (error) throw new Error(error.message);

          if (!matches || matches.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `No task matching "${params.title_search}"` }) }],
            };
          }
          if (matches.length > 1) {
            const candidates = matches.map((t: any) => ({
              id: t.id,
              title: t.title,
              project: t.project?.name || "Inbox",
              due_date: t.due_date,
            }));
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ message: "Multiple matches — please specify by ID", candidates }, null, 2) }],
            };
          }
          task = matches[0];
        }

        if (!task) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found. Provide task_id or title_search." }) }],
          };
        }

        // Fetch subtasks
        const { data: subtasks } = await supabase
          .from("tasks")
          .select("id, title, status, priority, due_date")
          .eq("parent_task_id", task.id)
          .order("sort_order");

        // Fetch dependencies (tasks that block this one)
        const { data: deps } = await supabase
          .from("task_dependencies")
          .select("depends_on_task_id")
          .eq("task_id", task.id);

        let blockers: any[] = [];
        if (deps && deps.length > 0) {
          const blockerIds = deps.map((d: any) => d.depends_on_task_id);
          const { data: blockerTasks } = await supabase
            .from("tasks")
            .select("id, title, status")
            .in("id", blockerIds);
          blockers = blockerTasks || [];
        }

        const result = {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          due_date: task.due_date,
          due_time: task.due_time,
          deadline: task.deadline,
          project: task.project?.name || "Inbox",
          project_id: task.project_id,
          section_id: task.section_id,
          recurrence: task.recurrence_rule ? describeRecurrence(task.recurrence_rule) : null,
          recurrence_rule: task.recurrence_rule,
          completed_at: task.completed_at,
          created_at: task.created_at,
          subtasks: (subtasks || []).map((s: any) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            priority: s.priority,
            due_date: s.due_date,
          })),
          blocked_by: blockers.map((b: any) => ({
            id: b.id,
            title: b.title,
            status: b.status,
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── get_portfolio_summary ──────────────────────────────────
    server.tool(
      "get_portfolio_summary",
      "Get a high-level summary of all tasks and projects. Returns inbox count, today's tasks, overdue tasks, project breakdown, and upcoming deadlines. Use for daily briefings or when the user asks 'what do I need to do?'",
      {},
      async () => {
        const today = todayDateString();

        const [
          { data: projects },
          { data: allTasks },
        ] = await Promise.all([
          supabase.from("projects").select("*").eq("owner_id", userId).eq("is_archived", false).order("sort_order"),
          supabase.from("tasks").select("*, project:projects(id, name, color)").eq("owner_id", userId).eq("status", "open").order("sort_order"),
        ]);

        const tasks = allTasks || [];
        const inboxTasks = tasks.filter((t: any) => !t.project_id);
        const todayTasks = tasks.filter((t: any) => t.due_date && t.due_date <= today);
        const overdueTasks = tasks.filter((t: any) => t.due_date && t.due_date < today);

        // Upcoming deadlines (hard deadlines in next 7 days)
        const weekOut = new Date();
        weekOut.setDate(weekOut.getDate() + 7);
        const weekOutStr = weekOut.toISOString().split("T")[0];
        const upcomingDeadlines = tasks
          .filter((t: any) => t.deadline && t.deadline >= today && t.deadline <= weekOutStr)
          .map((t: any) => ({
            title: t.title,
            deadline: t.deadline,
            project: t.project?.name || "Inbox",
          }));

        // Tasks by project
        const projectSummaries = (projects || []).map((p: any) => {
          const projectTasks = tasks.filter((t: any) => t.project_id === p.id);
          return {
            name: p.name,
            color: p.color,
            open_tasks: projectTasks.length,
            overdue: projectTasks.filter((t: any) => t.due_date && t.due_date < today).length,
          };
        });

        // High priority tasks
        const highPriority = tasks
          .filter((t: any) => t.priority >= 2)
          .slice(0, 10)
          .map((t: any) => ({
            title: t.title,
            priority: t.priority,
            due_date: t.due_date,
            project: t.project?.name || "Inbox",
          }));

        const result = {
          total_open_tasks: tasks.length,
          inbox_count: inboxTasks.length,
          today_count: todayTasks.length,
          overdue_count: overdueTasks.length,
          overdue_tasks: overdueTasks.slice(0, 10).map((t: any) => ({
            id: t.id,
            title: t.title,
            due_date: t.due_date,
            project: t.project?.name || "Inbox",
            priority: t.priority,
          })),
          today_tasks: todayTasks.slice(0, 15).map((t: any) => ({
            id: t.id,
            title: t.title,
            due_date: t.due_date,
            project: t.project?.name || "Inbox",
            priority: t.priority,
          })),
          high_priority: highPriority,
          upcoming_deadlines: upcomingDeadlines,
          projects: projectSummaries,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── create_task ────────────────────────────────────────────
    server.tool(
      "create_task",
      "Create a new task in Intend. Use when the user says things like 'remind me to...', 'add a task to...', or 'I need to...'",
      {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description/notes"),
        project_name: z.string().optional().describe("Project name (fuzzy matched). Omit for Inbox."),
        due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        deadline: z.string().optional().describe("Hard deadline (YYYY-MM-DD)"),
        priority: z.number().min(0).max(3).optional().describe("Priority: 0=none, 1=low, 2=medium, 3=high"),
        recurrence_rule: z.string().optional().describe("RRULE string (e.g. FREQ=WEEKLY;BYDAY=MO,TH)"),
        parent_task_id: z.string().optional().describe("Parent task ID to create as subtask"),
      },
      async (params) => {
        let projectId: string | null = null;

        if (params.project_name) {
          const { data: projects } = await supabase
            .from("projects")
            .select("id, name")
            .eq("owner_id", userId)
            .eq("is_archived", false)
            .ilike("name", `%${params.project_name}%`);

          if (!projects || projects.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `No project matching "${params.project_name}". Task not created.` }) }],
            };
          }
          if (projects.length > 1) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "Multiple projects match. Please be more specific.",
                candidates: projects.map((p: any) => p.name),
              }) }],
            };
          }
          projectId = projects[0].id;
        }

        const insert: any = {
          owner_id: userId,
          title: params.title,
          description: params.description || null,
          project_id: projectId,
          due_date: params.due_date || null,
          deadline: params.deadline || null,
          priority: params.priority ?? 0,
          recurrence_rule: params.recurrence_rule || null,
          recurrence_base_date: params.due_date || null,
          parent_task_id: params.parent_task_id || null,
        };

        const { data, error } = await supabase
          .from("tasks")
          .insert(insert)
          .select("*, project:projects(id, name, color)")
          .single();

        if (error) throw new Error(error.message);

        const result = {
          id: data.id,
          title: data.title,
          project: data.project?.name || "Inbox",
          due_date: data.due_date,
          deadline: data.deadline,
          priority: data.priority,
          recurrence: data.recurrence_rule ? describeRecurrence(data.recurrence_rule) : null,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── update_task ────────────────────────────────────────────
    server.tool(
      "update_task",
      "Update a task's title, description, due date, priority, project, or other fields. Use when the user wants to reschedule, reprioritize, or modify a task.",
      {
        task_id: z.string().optional().describe("Task ID"),
        title_search: z.string().optional().describe("Find task by title (fuzzy match)"),
        title: z.string().optional().describe("New title"),
        description: z.string().nullable().optional().describe("New description"),
        due_date: z.string().nullable().optional().describe("New due date (YYYY-MM-DD)"),
        deadline: z.string().nullable().optional().describe("New deadline (YYYY-MM-DD)"),
        priority: z.number().min(0).max(3).optional().describe("New priority"),
        project_name: z.string().nullable().optional().describe("Move to project (fuzzy match). Null for Inbox."),
        recurrence_rule: z.string().nullable().optional().describe("New RRULE string or null to remove"),
      },
      async (params) => {
        // Resolve task
        let taskId = params.task_id;
        if (!taskId && params.title_search) {
          const { data: matches } = await supabase
            .from("tasks")
            .select("id, title")
            .eq("owner_id", userId)
            .eq("status", "open")
            .ilike("title", `%${params.title_search}%`)
            .limit(5);

          if (!matches || matches.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No task matching "${params.title_search}"` }) }] };
          }
          if (matches.length > 1) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Multiple matches", candidates: matches }) }] };
          }
          taskId = matches[0].id;
        }

        if (!taskId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Provide task_id or title_search" }) }] };
        }

        const updateData: any = {};
        if (params.title !== undefined) updateData.title = params.title;
        if (params.description !== undefined) updateData.description = params.description;
        if (params.due_date !== undefined) updateData.due_date = params.due_date;
        if (params.deadline !== undefined) updateData.deadline = params.deadline;
        if (params.priority !== undefined) updateData.priority = params.priority;
        if (params.recurrence_rule !== undefined) {
          updateData.recurrence_rule = params.recurrence_rule;
          if (params.recurrence_rule && params.due_date) {
            updateData.recurrence_base_date = params.due_date;
          }
        }

        // Resolve project
        if (params.project_name !== undefined) {
          if (params.project_name === null) {
            updateData.project_id = null;
          } else {
            const { data: projects } = await supabase
              .from("projects")
              .select("id, name")
              .eq("owner_id", userId)
              .eq("is_archived", false)
              .ilike("name", `%${params.project_name}%`);

            if (!projects || projects.length === 0) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No project matching "${params.project_name}"` }) }] };
            }
            if (projects.length > 1) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Multiple projects match", candidates: projects.map((p: any) => p.name) }) }] };
            }
            updateData.project_id = projects[0].id;
          }
        }

        if (Object.keys(updateData).length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }] };
        }

        const { data, error } = await supabase
          .from("tasks")
          .update(updateData)
          .eq("id", taskId)
          .eq("owner_id", userId)
          .select("*, project:projects(id, name, color)")
          .single();

        if (error) throw new Error(error.message);

        const result = {
          id: data.id,
          title: data.title,
          project: data.project?.name || "Inbox",
          due_date: data.due_date,
          deadline: data.deadline,
          priority: data.priority,
          status: data.status,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── complete_task ──────────────────────────────────────────
    server.tool(
      "complete_task",
      "Mark a task as done. If the task is recurring, a new occurrence is automatically created. Use when the user says they finished something.",
      {
        task_id: z.string().optional().describe("Task ID"),
        title_search: z.string().optional().describe("Find task by title (fuzzy match)"),
      },
      async (params) => {
        // Resolve task
        let task: any = null;

        if (params.task_id) {
          const { data } = await supabase
            .from("tasks")
            .select("*")
            .eq("id", params.task_id)
            .eq("owner_id", userId)
            .single();
          task = data;
        } else if (params.title_search) {
          const { data: matches } = await supabase
            .from("tasks")
            .select("*")
            .eq("owner_id", userId)
            .eq("status", "open")
            .ilike("title", `%${params.title_search}%`)
            .limit(5);

          if (matches && matches.length === 1) {
            task = matches[0];
          } else if (matches && matches.length > 1) {
            return { content: [{ type: "text" as const, text: JSON.stringify({
              error: "Multiple matches",
              candidates: matches.map((t: any) => ({ id: t.id, title: t.title })),
            }) }] };
          }
        }

        if (!task) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
        }

        // Mark as done
        const { error } = await supabase
          .from("tasks")
          .update({ status: "done", completed_at: new Date().toISOString() })
          .eq("id", task.id);

        if (error) throw new Error(error.message);

        // Handle recurrence
        let nextTask: any = null;
        if (task.recurrence_rule) {
          const dueDateUtcNoon = task.due_date
            ? new Date(task.due_date + "T12:00:00Z")
            : new Date();
          const todayUtcNoon = new Date(todayDateString() + "T12:00:00Z");
          const afterDate = dueDateUtcNoon > todayUtcNoon ? dueDateUtcNoon : todayUtcNoon;
          const nextDate = getNextOccurrence(task.recurrence_rule, afterDate);

          if (nextDate) {
            const nextDueDate = nextDate.toISOString().split("T")[0];
            const { data: spawned } = await supabase
              .from("tasks")
              .insert({
                owner_id: task.owner_id,
                title: task.title,
                description: task.description,
                project_id: task.project_id,
                section_id: task.section_id,
                parent_task_id: task.parent_task_id,
                priority: task.priority,
                due_date: nextDueDate,
                due_time: task.due_time,
                recurrence_rule: task.recurrence_rule,
                recurrence_base_date: task.recurrence_base_date,
                sort_order: task.sort_order,
              })
              .select()
              .single();
            nextTask = spawned;
          }
        }

        const result: any = {
          completed: { id: task.id, title: task.title },
        };
        if (nextTask) {
          result.next_occurrence = {
            id: nextTask.id,
            title: nextTask.title,
            due_date: nextTask.due_date,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── delete_task ────────────────────────────────────────────
    server.tool(
      "delete_task",
      "Delete a task permanently. Use when the user wants to remove a task entirely (not just complete it).",
      {
        task_id: z.string().optional().describe("Task ID"),
        title_search: z.string().optional().describe("Find task by title (fuzzy match)"),
      },
      async (params) => {
        let taskId = params.task_id;
        let taskTitle = "";

        if (!taskId && params.title_search) {
          const { data: matches } = await supabase
            .from("tasks")
            .select("id, title")
            .eq("owner_id", userId)
            .eq("status", "open")
            .ilike("title", `%${params.title_search}%`)
            .limit(5);

          if (!matches || matches.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No task matching "${params.title_search}"` }) }] };
          }
          if (matches.length > 1) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Multiple matches", candidates: matches }) }] };
          }
          taskId = matches[0].id;
          taskTitle = matches[0].title;
        }

        if (!taskId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Provide task_id or title_search" }) }] };
        }

        if (!taskTitle) {
          const { data } = await supabase.from("tasks").select("title").eq("id", taskId).single();
          taskTitle = data?.title || "";
        }

        const { error } = await supabase
          .from("tasks")
          .delete()
          .eq("id", taskId)
          .eq("owner_id", userId);

        if (error) throw new Error(error.message);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ deleted: true, title: taskTitle }) }],
        };
      }
    );

    // ─── get_projects ───────────────────────────────────────────
    server.tool(
      "get_projects",
      "List all active projects. Use when the user asks about their projects or wants to see what they're working on.",
      {
        include_archived: z.boolean().optional().describe("Include archived projects"),
      },
      async (params) => {
        let query = supabase
          .from("projects")
          .select("*")
          .eq("owner_id", userId)
          .order("sort_order");

        if (!params.include_archived) {
          query = query.eq("is_archived", false);
        }

        const { data: projects, error } = await query;
        if (error) throw new Error(error.message);

        // Get task counts per project
        const { data: tasks } = await supabase
          .from("tasks")
          .select("project_id")
          .eq("owner_id", userId)
          .eq("status", "open");

        const taskCounts: Record<string, number> = {};
        for (const t of tasks || []) {
          if (t.project_id) {
            taskCounts[t.project_id] = (taskCounts[t.project_id] || 0) + 1;
          }
        }

        const results = (projects || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          color: p.color,
          is_archived: p.is_archived,
          open_tasks: taskCounts[p.id] || 0,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      }
    );

    // ─── get_project_detail ─────────────────────────────────────
    server.tool(
      "get_project_detail",
      "Get full project details with sections and all tasks. Use when the user asks about a specific project.",
      {
        project_id: z.string().optional().describe("Project ID"),
        project_name: z.string().optional().describe("Project name (fuzzy match)"),
      },
      async (params) => {
        let projectId = params.project_id;

        if (!projectId && params.project_name) {
          const { data: projects } = await supabase
            .from("projects")
            .select("id, name")
            .eq("owner_id", userId)
            .ilike("name", `%${params.project_name}%`);

          if (!projects || projects.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No project matching "${params.project_name}"` }) }] };
          }
          if (projects.length > 1) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Multiple matches", candidates: projects.map((p: any) => p.name) }) }] };
          }
          projectId = projects[0].id;
        }

        if (!projectId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Provide project_id or project_name" }) }] };
        }

        const { data: project, error } = await supabase
          .from("projects")
          .select("*, sections(*, tasks(*))")
          .eq("id", projectId)
          .single();

        if (error) throw new Error(error.message);

        // Also get tasks without a section
        const { data: unsectionedTasks } = await supabase
          .from("tasks")
          .select("*")
          .eq("project_id", projectId)
          .is("section_id", null)
          .eq("status", "open")
          .order("sort_order");

        const result = {
          id: project.id,
          name: project.name,
          description: project.description,
          color: project.color,
          is_archived: project.is_archived,
          unsectioned_tasks: (unsectionedTasks || []).map((t: any) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            due_date: t.due_date,
            deadline: t.deadline,
          })),
          sections: (project.sections || [])
            .sort((a: any, b: any) => a.sort_order - b.sort_order)
            .map((s: any) => ({
              id: s.id,
              name: s.name,
              tasks: (s.tasks || [])
                .filter((t: any) => t.status === "open")
                .sort((a: any, b: any) => a.sort_order - b.sort_order)
                .map((t: any) => ({
                  id: t.id,
                  title: t.title,
                  status: t.status,
                  priority: t.priority,
                  due_date: t.due_date,
                  deadline: t.deadline,
                })),
            })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── create_project ─────────────────────────────────────────
    server.tool(
      "create_project",
      "Create a new project. Use when the user wants to organize tasks into a new project.",
      {
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        color: z.string().optional().describe("Hex color (e.g. #ff5733)"),
      },
      async (params) => {
        const { data, error } = await supabase
          .from("projects")
          .insert({
            owner_id: userId,
            name: params.name,
            description: params.description || null,
            color: params.color || "#808080",
          })
          .select()
          .single();

        if (error) throw new Error(error.message);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            id: data.id,
            name: data.name,
            color: data.color,
          }, null, 2) }],
        };
      }
    );

    // ─── search_tasks ───────────────────────────────────────────
    server.tool(
      "search_tasks",
      "Search tasks by title. Use when the user is looking for a specific task but doesn't know the exact name or ID.",
      {
        query: z.string().describe("Search text (matched against title)"),
        include_completed: z.boolean().optional().describe("Include completed tasks in results"),
      },
      async (params) => {
        let query = supabase
          .from("tasks")
          .select("id, title, status, due_date, priority, project:projects(id, name, color)")
          .eq("owner_id", userId)
          .ilike("title", `%${params.query}%`)
          .limit(15);

        if (!params.include_completed) {
          query = query.eq("status", "open");
        }

        const { data: tasks, error } = await query;
        if (error) throw new Error(error.message);

        const results = (tasks || []).map((t: any) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          due_date: t.due_date,
          priority: t.priority,
          project: t.project?.name || "Inbox",
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      }
    );
  },
  {},
  { basePath: "/api" }
);

// Verify bearer tokens — accepts both direct bearer tokens and OAuth-issued tokens
const verifyToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;

  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || bearerToken !== expected) return undefined;

  return {
    token: bearerToken,
    scopes: ["mcp:tools"],
    clientId: "intend-user",
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
