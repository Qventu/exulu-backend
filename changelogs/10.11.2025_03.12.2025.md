
----

### feat: add project-scoped context retrieval and enhanced personalization

Date: 2025-12-03
Author: dclaessen-exulu

This commit introduces a comprehensive project-based information retrieval
system and several enhancements to the agent and context infrastructure:

**Project Context Retrieval:**
- Add createProjectRetrievalTool for project-specific information search
  across multiple contexts
- Implement project caching mechanism to optimize repeated project queries
- Support hybrid search across project items with filtering and ranking
- Enable automatic project tool injection when session has associated
  project

**Enhanced Personalization:**
- Add firstname/lastname fields to user authentication for API users
- Include user information in system prompts for better personalization
- Make personalization configurable via privacy settings

**Field Processor Improvements:**
- Add generateEmbeddings configuration option to field processors
- Support onInsert trigger in addition to existing triggers
- Enable processors to run without user context for system operations
- Improve processor execution flow with better logging

**Infrastructure Enhancements:**
- Add database connection pool logging for debugging
- Improve file parts processing with better error handling
- Make convertToolsArrayToObject async to support dynamic tool generation
- Enhance storage utility to support uploads without user context
- Better handling of tool variable configs vs execution configs
- Comment out unused project_id from RBAC schema

**Context and Search Improvements:**
- Add search method directly to ExuluContext class
- Expose applyFilters and contextToTableDefinition utilities
- Support context source execution with exuluConfig parameter
- Improve error messages and reduce excessive logging

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### feat: add document parsing for AI agent file handling with JWT secret fix

Date: 2025-11-30
Author: dclaessen-exulu

Enhance agent file processing capabilities and fix authentication:

- Add officeparser integration to extract text from document files
- Implement processFilePartsInMessages to convert file parts to
  OpenAI Responses API compatible format
- Convert document files to text parts with extracted content
- Keep image files as image parts (natively supported by API)
- Add message deduplication to prevent duplicate message IDs
- Change saveChat to process messages sequentially for correct
  timestamp ordering
- Fix JWT verification in getToken by converting NEXTAUTH_SECRET
  to base64url format as required by jose library

This enables agents to process uploaded documents by extracting
their text content and presenting it in a format compatible with
the OpenAI Responses API.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### feat: add PDF preview tool and enhance agent API with cookie authentication and message persistence

Date: 2025-11-26
Author: dclaessen-exulu

Adds a new preview-pdf tool for viewing PDF documents and significantly enhances the agent
chat API to support public agents with optional authentication. Implements cookie-based session
management, message ID tracking to prevent duplicates during chat persistence, and allows
passing full message arrays for stateless interactions.

Also downgrades AI SDK from v5.0.95 to v5.0.65 for stability, adds cookie-parser dependency,
and improves context embedding generation with better metadata handling and increased timeout
limits. Enhances S3 integration with multi-bucket support by making the bucket always be the part of the key before the first slash
improves vector search result limits, and adds better error handling for encrypted variables
and external ID lookups in context operations.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### fix: issue with upsert

Date: 2025-11-19
Author: dclaessen-exulu


----

### feat: upgrade AI SDK to v5.0.95 and add Gemini 3 Pro support with parameterized context sources

Date: 2025-11-19
Author: dclaessen-exulu

This commit introduces several enhancements to the AI capabilities and context system:

- Upgrade AI SDK from v5.0.56 to v5.0.95 with improved provider utilities
- Add @vercel/oidc dependency for enhanced authentication support
- Implement Google Vertex Gemini 3 Pro agent with 1M+ token context window
- Enhance context source configuration with parameterizable inputs
- Improve Vertex authentication documentation with detailed setup instructions
- Add support for dynamic parameters in context source definitions via GraphQL schema

The new Gemini 3 Pro agent provides very high intelligence with moderate speed,
supporting text, images, files, audio, and video inputs. Context sources can now
define parameters with names, descriptions, and default values for more flexible
data retrieval configurations.

Changes include:
- src/index.ts: Export new vertexGemini3ProAgent
- src/registry/index.ts: Register Gemini 3 Pro agent
- src/registry/classes.ts: Add params field to ExuluContextSource config
- src/registry/utils/graphql.ts: Add ContextSourceParam type and params support
- src/templates/agents/google/vertex/index.ts: Add Gemini 3 Pro agent, refactor auth docs
- types/models/context.ts: Add params field to Context interface

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### feat: add Google Vertex AI agent support and enhance embedder configuration system

Date: 2025-11-18
Author: dclaessen-exulu

Add Google Vertex Gemini 2.5 Flash agent integration with support for
optional authentication. Implement new embedder_settings table for
context-specific embedder configuration with variable management.

Major changes:
- Add vertexGemini25FlashAgent to default agents and registry
- Implement embedder_settings schema for per-context embedder config
- Add authenticationInformation field to ExuluAgent class
- Make providerapikey optional across agent and MCP initialization
- Add config field to ExuluEmbedder with hydrateEmbedderConfig method
- Pass context ID and settings to embedder chunker and generation ops
- Update GraphQL schema to expose authenticationInformation and config
- Enhance error messages with agent name and ID for better debugging

Breaking changes:
- ChunkerOperation signature now requires config parameter
- VectorGenerateOperation signature now requires settings parameter
- convertToolsArrayToObject contexts parameter now optional

This enables agents that don't require API keys (e.g., Vertex AI with
workload identity) and allows embedders to retrieve configuration from
variables per context.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### fix: project tracking anthropic passthrough and timeout for worker

Date: 2025-11-17
Author: dclaessen-exulu


----

### feat: add MCP prompt library integration and JSON filtering enhancements

Date: 2025-11-17
Author: dclaessen-exulu

Add comprehensive prompt template management via MCP tools and enhanced JSON field filtering:

Prompt Library Features:
- Add prompt_library and prompt_favorites database schemas
- Register getListOfPromptTemplates and getPromptTemplateDetails MCP tools
- Enable agents to discover and retrieve prompt templates with usage/favorite tracking
- Support agent-specific prompt assignment via assigned_agents JSON field

GraphQL & Filtering Improvements:
- Add JSON field containment support using PostgreSQL @> operator
- Enhance filter operators to handle JSON equality and IN operations with jsonb casting
- Pass table schema context to applyFilters for type-aware query building

Bug Fixes & Refinements:
- Fix upsert validation to require id or external_id
- Add source update statistics tracking for API and job triggers
- Improve eval function result metadata structure with function_results array
- Add default scoring method fallback to average for eval runs
- Fix typo: rename eval to evaluation in bullmq decorator

Configuration:
- Add .mcp.json for exulu-mcp-server-default-coding-agent integration

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### feat: add todo system, enhanced roles, session metadata, and scheduling support

Date: 2025-11-14
Author: dclaessen-exulu

This commit introduces several significant features and improvements to the Exulu backend:

- Implement TodoWrite and TodoRead tools for session-based task tracking
- Store todos in agent_sessions.metadata JSON field
- Add access control checks for todo operations
- Tools require authenticated session context

- Create default "admin" role with full write permissions
- Create "default" role with agent write + read-only for other resources
- Add support for "evals" and "api" permissions in role structure
- Automatically provision both roles during database initialization

- Add metadata JSON column to agent_sessions table
- Pass sessionID throughout tool execution pipeline
- Implement getSession helper for consistent session retrieval
- Enable session-aware tool execution with user context

- Add cron-like scheduling support for context data sources
- Implement queue configuration options
- Add retry logic with exponential/linear backoff strategies
- Enable automated data ingestion workflows

- Fix Redis URL construction when using authentication
- Improve handling of username/password credentials
- Better fallback values for missing environment variables

- Support config-based tool description overrides
- Pass sessionID to all tool executions
- Enable tools to access session metadata
- Improve tool configuration hydration

- Add better-auth (v1.3.34) with WebAuthn support
- Include cryptography libraries (@noble/ciphers, @noble/hashes)
- Add @simplewebauthn packages for authentication flows
- Include kysely for type-safe database queries

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### fix: add ExuluItem as export

Date: 2025-11-11
Author: dclaessen-exulu


----

### feat: implement scheduled data sources for contexts

Date: 2025-11-11
Author: dclaessen-exulu

Add support for scheduled data sources within ExuluContext that automatically
fetch and ingest items at regular intervals.

Key changes:
- Introduce ExuluContextSource type with configurable cron schedules, retry
  logic, and backoff strategies
- Add source execution handler in BullMQ workers to process scheduled jobs
- Create automatic job schedulers for each context source with configurable
  retry attempts (default: 3) and exponential backoff (default: 2000ms)
- Rename Context.process() to processField() for clarity
- Add executeSource() method to handle source execution and item creation
- Track source metadata in BullMQ job data for job identification

Sources enable automated data ingestion workflows where external data can be
pulled into contexts on a schedule without manual intervention. Each source
execution creates items in the context and optionally schedules follow-up
processing jobs for embeddings and chunking.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>

----

### fix: minor exulu upgrade for redis connection

Date: 2025-11-10
Author: dclaessen-exulu


----

### fix: redis auth url

Date: 2025-11-10
Author: dclaessen-exulu


----
