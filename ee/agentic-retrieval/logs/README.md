# Agentic Retrieval Trajectory Logs

This directory contains detailed logs of every retrieval trajectory executed by the v2 agentic retrieval system.

## Purpose

These logs capture the complete "thinking process" of the retrieval agent, including:
- Initial query and detected language
- Each reasoning step and decision
- Every tool call with inputs and outputs
- Dynamic tools created during execution
- Token usage and performance metrics
- Final results and success/failure status

## Directory Structure

```
logs/
├── YYYY-MM-DD/              # Logs organized by date
│   ├── traj_*.json          # Individual trajectory logs
│   └── _daily_summary.jsonl # Daily summary (one line per trajectory)
└── README.md                # This file
```

## Trajectory File Format

Each trajectory is saved as a JSON file with this structure:

```json
{
  "trajectory_id": "traj_1234567890_abc123def",
  "timestamp": "2026-04-09T10:30:45.123Z",
  "initial_query": "wie sind die Abmessungen vom Liftstarter 16kw",
  "detected_language": "deu",
  "available_contexts": ["techDoc", "vorschriften"],
  "enabled_contexts": ["techDoc", "vorschriften"],
  "reranker_used": "cohere-rerank-multilingual-v3",
  "custom_instructions": "...",

  "steps": [
    {
      "step_number": 1,
      "timestamp": "2026-04-09T10:30:45.234Z",

      "reasoning": {
        "text": "I must call tool search_content with...",
        "finished": false,
        "tokens_used": 1250,
        "duration_ms": 850
      },

      "tool_execution": {
        "tools_called": [
          {
            "tool_name": "search_content",
            "tool_id": "call_abc123",
            "input": {
              "query": "Liftstarter 16kw Abmessungen",
              "knowledge_base_ids": ["techDoc"],
              "searchMethod": "hybrid",
              "limit": 10
            },
            "output_summary": "[{\"item_name\":\"Liftstarter_16kw.pdf\",\"chunk_content\":\"Die Abmessungen...",
            "output_length": 15234,
            "success": true,
            "duration_ms": 1200
          }
        ],
        "chunks_retrieved": 10,
        "chunks_after_reranking": 8,
        "total_tokens_used": 3500
      },

      "dynamic_tools_created": [
        "get_more_content_from_Liftstarter_16kw_pdf",
        "get_Liftstarter_16kw_pdf_page_1_content"
      ]
    }
  ],

  "final_results": {
    "total_chunks": 8,
    "total_steps": 2,
    "total_tokens": 4750,
    "total_duration_ms": 3250,
    "success": true
  },

  "performance": {
    "tokens_per_step": [1250, 3500],
    "avg_tokens_per_step": 2375,
    "chunks_per_step": [10, 0],
    "tool_usage_frequency": {
      "search_content": 1,
      "count_items_or_chunks": 0,
      "save_search_results": 0
    }
  }
}
```

## Daily Summary Format

The `_daily_summary.jsonl` file contains one JSON object per line (newline-delimited JSON):

```jsonl
{"trajectory_id":"traj_1234567890_abc123def","timestamp":"2026-04-09T10:30:45.123Z","query":"wie sind die Abmessungen vom Liftstarter 16kw","tokens":4750,"chunks":8,"steps":2,"duration_ms":3250,"success":true}
{"trajectory_id":"traj_1234567891_def456ghi","timestamp":"2026-04-09T11:15:22.456Z","query":"count all documents","tokens":1200,"chunks":0,"steps":1,"duration_ms":800,"success":true}
```

## Using These Logs for Analysis

### 1. Analyze Successful vs Failed Retrievals

```bash
# Find all failed retrievals
cat logs/2026-04-09/_daily_summary.jsonl | jq 'select(.success == false)'

# Find trajectories that used many tokens
cat logs/2026-04-09/_daily_summary.jsonl | jq 'select(.tokens > 5000)'
```

### 2. Identify Common Tool Usage Patterns

```bash
# Extract tool usage frequency from all trajectories
for file in logs/2026-04-09/traj_*.json; do
  jq '.performance.tool_usage_frequency' "$file"
done
```

### 3. Find Queries That Needed Multiple Steps

```bash
# Trajectories with more than 2 steps
cat logs/2026-04-09/_daily_summary.jsonl | jq 'select(.steps > 2)'
```

### 4. Review Specific Trajectory

```bash
# Pretty-print a specific trajectory
jq '.' logs/2026-04-09/traj_1234567890_abc123def.json
```

### 5. Analyze Agent Reasoning

```bash
# Extract all reasoning text from a trajectory
jq '.steps[].reasoning.text' logs/2026-04-09/traj_1234567890_abc123def.json
```

## Improvement Workflow

1. **Collect trajectories** over a period (e.g., 1 week)
2. **Identify patterns**:
   - Which queries consistently fail?
   - Which tool combinations work well?
   - Are there inefficient search strategies?
3. **Analyze specific failed cases**:
   - What did the agent try?
   - Why did it fail?
   - What should it have done instead?
4. **Update agent instructions** based on findings
5. **Compare before/after** trajectories to measure improvement

## Example Analysis Questions

- **Token Efficiency**: Are certain query types using too many tokens?
- **Tool Selection**: Is the agent choosing the right tools for the job?
- **Search Strategy**: Is hybrid search always best, or do some queries benefit from keyword-only?
- **Multi-step Reasoning**: When does the agent need multiple steps vs single step?
- **Dynamic Tools**: Are get_more_content tools being used effectively?
- **Failure Patterns**: What causes retrieval failures?

## Feeding Trajectories Back to Claude Code

To analyze a trajectory:

1. Find the trajectory file (e.g., `logs/2026-04-09/traj_1234567890_abc123def.json`)
2. Share it with Claude Code for analysis:

```
I want you to analyze this retrieval trajectory and suggest improvements:
[paste contents of trajectory file]

Please analyze:
1. Was the agent's reasoning logical?
2. Did it choose the right tools?
3. Could it have been more efficient?
4. What would you change about the search strategy?
```

Claude Code can then provide specific recommendations for improving the agent's behavior.

## Privacy Note

Trajectory logs may contain sensitive information from user queries and retrieved content. Ensure proper access controls on the logs directory.
