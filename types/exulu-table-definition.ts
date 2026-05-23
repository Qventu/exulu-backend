import type { ExuluContextFieldDefinition } from "@SRC/exulu/context";
import type { ExuluContextProcessor } from "./context-processor";

export type ExuluTableDefinition = {
    type?:
    | "skills"
    | "context_presets"
    | "feedback"
    | "test_cases"
    | "eval_sets"
    | "eval_runs"
    | "agent_sessions"
    | "agent_messages"
    | "eval_results"
    | "workflow_templates"
    | "tracking"
    | "rbac"
    | "users"
    | "variables"
    | "roles"
    | "agents"
    | "items"
    | "models"
    | "projects"
    | "project_items"
    | "platform_configurations"
    | "job_results"
    | "prompt_library"
    | "prompt_favorites"
    | "embedder_settings";
    id?: string;
    name: {
      plural:
      | "skills"
      | "context_presets"
      | "feedback"
      | "test_cases"
      | "eval_sets"
      | "eval_runs"
      | "agent_sessions"
      | "agent_messages"
      | "eval_results"
      | "workflow_templates"
      | "tracking"
      | "rbac"
      | "users"
      | "variables"
      | "roles"
      | "agents"
      | "models"
      | "projects"
      | "project_items"
      | "platform_configurations"
      | "job_results"
      | "prompt_library"
      | "prompt_favorites"
      | "embedder_settings";
      singular:
      | "skill"
      | "context_preset"
      | "feedback"
      | "test_case"
      | "eval_set"
      | "eval_run"
      | "agent_session"
      | "agent_message"
      | "eval_result"
      | "workflow_template"
      | "tracking"
      | "rbac"
      | "user"
      | "variable"
      | "role"
      | "agent"
      | "model"
      | "project"
      | "project_item"
      | "platform_configuration"
      | "job_result"
      | "prompt_library_item"
      | "prompt_favorite"
      | "embedder_setting";
    };
    processor?: ExuluContextProcessor;
    fields: ExuluContextFieldDefinition[];
    RBAC?: boolean;
    graphql?: boolean;
  };