<a href="https://exulu.com/"><img width="100%" src="https://mintlify.s3.us-west-1.amazonaws.com/exulu/images/create_agents.png" alt="Exulu IMP - Create, deploy and manage AI agents" /></a>

<br />
<br />

<p align="left">
  <a href="https://github.com/Qventu/exulu-backend/actions"><img alt="GitHub Workflow Status" src="https://img.shields.io/github/actions/workflow/status/Qventu/exulu-backend/main.yml?style=flat-square"></a>
  &nbsp;
  <a href="https://discord.com/channels/936044636693221439"><img alt="Discord" src="https://img.shields.io/discord/936044636693221439?label=Discord&color=7289da&style=flat-square" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@exulu/backend"><img alt="npm downloads" src="https://img.shields.io/npm/dw/@exulu/backend?style=flat-square" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@exulu/backend"><img alt="npm version" src="https://img.shields.io/npm/v/@exulu/backend?style=flat-square" /></a>
  &nbsp;
  <img alt="Node.js version" src="https://img.shields.io/badge/Node.js-22.18.0-green?style=flat-square" />
</p>

<hr/>

<h4>
<a target="_blank" href="https://docs.exulu.com" rel="dofollow"><strong>📚 Explore the Docs</strong></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a target="_blank" href="https://exulu.com/community-help" rel="dofollow"><strong>💬 Community Help</strong></a>&nbsp;&nbsp;·&nbsp;&nbsp;<a target="_blank" href="https://github.com/Qventu/exulu-backend/discussions/2" rel="dofollow"><strong>🗺️ Roadmap</strong></a>
</h4>

<hr/>

> [!IMPORTANT]
> ⭐ Star this repo to follow development and updates

**Exulu IMP** (Intelligence Management Platform) is an open-source TypeScript framework for building production-ready AI agent applications. It provides the backend infrastructure for managing agents, semantic search contexts, background job processing, and tool integrations.

<h3>✨ Why Exulu IMP?</h3>

<ul>
  <li>🤖 <strong>Multi-provider agents</strong> - Built-in support for OpenAI, Anthropic, Google, Cerebras and any AI SDK provider</li>
  <li>🔍 <strong>Semantic search</strong> - Vector-powered RAG with pgvector and automatic embedding generation</li>
  <li>⚙️ <strong>Background workers</strong> - BullMQ-based job queues for long-running tasks</li>
  <li>🔐 <strong>Authentication</strong> - API keys, NextAuth integration, and role-based access control</li>
  <li>🛠️ <strong>Tool system</strong> - Extend agent capabilities with custom functions and external APIs</li>
  <li>📦 <strong>Self-hosted</strong> - Deploy anywhere you want, no vendor lock-in</li>
  <li>🔌 <strong>Express API</strong> - GraphQL and REST endpoints out of the box</li>
  <li>📊 <strong>OpenTelemetry</strong> - Built-in logging and tracing with SigNoz integration</li>
  <li>⚡ <strong>TypeScript-first</strong> - Fully typed with automatic type inference</li>
</ul>

## 🚀 Quickstart

### Installation

```bash
npm install @exulu/backend
```

### Basic setup

```typescript
import { ExuluApp, ExuluAgent, ExuluDefaultAgents } from "@exulu/backend";

const app = new ExuluApp();

await app.create({
  config: {
    express: { enabled: true, port: 3000 },
    workers: { enabled: true },
    telemetry: { enabled: false }
  },
  agents: [
    ExuluDefaultAgents.anthropic.sonnet45,
    ExuluDefaultAgents.openai.gpt5
  ],
  contexts: {},
  tools: []
});

const server = await app.express.init();
server.listen(3000, () => {
  console.log("🚀 Exulu IMP running on http://localhost:3000");
});
```

**For a complete working example**, check out the [Exulu Example Repository](https://github.com/Qventu/exulu-example) which includes:

- Docker Compose setup for PostgreSQL, Redis, and MinIO
- Pre-configured agents and contexts
- Worker implementation
- Environment configuration templates
- Database initialization scripts

## 🎨 Admin Frontend

<div align="center">

### **[Exulu Frontend →](https://github.com/Qventu/exulu-frontend)**

<a href="https://github.com/Qventu/exulu-frontend">
  <img src="https://img.shields.io/badge/Exulu-Frontend-16A34A?style=for-the-badge&logo=react&logoColor=white" alt="Exulu Frontend" />
</a>

**Modern React admin interface for managing your AI agents, contexts, and workflows**

</div>

The [**Exulu Frontend**](https://github.com/Qventu/exulu-frontend) provides a beautiful, production-ready admin interface built with **Next.js 15**, **React 19**, and **Tailwind CSS**.

<table>
<tr>
<td width="50%">

**✨ Features**
- 🎯 Agent management & configuration
- 📊 Real-time session monitoring
- 🗄️ Context & knowledge base management
- 🔧 Tool & workflow builder
- 👥 User & role management
- 📈 Usage statistics & analytics

</td>
<td width="50%">

**🚀 Quick Start**
```bash
# Using npx (recommended)
npx @exulu/frontend

# Or install globally
npm install -g @exulu/frontend
exulu-frontend
```

Connects to your Exulu IMP backend automatically!

</td>
</tr>
</table>

<details>
<a href="https://exulu.com/"><img width="100%" src="https://mintlify.s3.us-west-1.amazonaws.com/exulu/images/admin_ui.png" alt="Exulu IMP - Create, deploy and manage AI agents" /></a>

<br/>

**Agent Management**
<img src="https://mintlify.s3.us-west-1.amazonaws.com/exulu/images/create_agents.png" alt="Agent Management" />

**Session Monitoring**
<img src="https://mintlify.s3.us-west-1.amazonaws.com/exulu/images/agent_session.png" alt="Session Monitoring" />

</details>

<div align="center">

**[📦 GitHub Repository](https://github.com/Qventu/exulu-frontend)** • **[📚 Documentation](https://docs.exulu.com)** • **[🎮 Live Demo](https://demo.exulu.com)**

</div>

---

## 📖 Documentation

Visit **[docs.exulu.com](https://docs.exulu.com)** for comprehensive documentation including:

- **[Quickstart Guide](https://docs.exulu.com/quickstart)** - Get up and running in minutes
- **[Core Classes](https://docs.exulu.com/core/exulu-app/introduction)** - Learn about ExuluApp, ExuluAgent, ExuluContext, and more
- **[API Reference](https://docs.exulu.com/api-reference/introduction)** - Complete API documentation
- **[Configuration](https://docs.exulu.com/core/exulu-app/configuration)** - Detailed configuration options

## 🏗️ Core concepts

### ExuluApp

The main application class that orchestrates all components:

```typescript
import { ExuluApp } from "@exulu/backend";

const agent = new ExuluAgent({
  id: "assistant",
  name: "Assistant",
  provider: "anthropic",
  type: "agent",
  maxContextLength: 200000,
  config: {
    model: {
      create: ({ apiKey }) => {
        const anthropic = createAnthropic({ apiKey });
        return anthropic.languageModel("claude-sonnet-4-5");
      }
    },
    instructions: "You are a helpful assistant."
  }
});

const app = new ExuluApp();
await app.create({
  config: {},
  agents: [agent],
  contexts: {...},
  tools: [...]
});
```

### ExuluAgent

Create AI agents with different LLM providers:

```typescript
import { ExuluAgent } from "@exulu/backend";
import { createAnthropic } from "@ai-sdk/anthropic";

const agent = new ExuluAgent({
  id: "assistant",
  name: "Assistant",
  provider: "anthropic",
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg"],
    files: [".pdf", ".docx"]
  },
  maxContextLength: 200000,
  config: {
    model: {
      create: ({ apiKey }) => {
        const anthropic = createAnthropic({ apiKey });
        return anthropic.languageModel("claude-sonnet-4-5");
      }
    },
    instructions: "You are a helpful assistant."
  }
});
```

Or use **pre-configured agents**:

```typescript
import { ExuluDefaultAgents } from "@exulu/backend";

// OpenAI
ExuluDefaultAgents.openai.gpt5;
ExuluDefaultAgents.openai.gpt4o;

// Anthropic
ExuluDefaultAgents.anthropic.opus4;
ExuluDefaultAgents.anthropic.sonnet45;

// Google
ExuluDefaultAgents.google.vertexGemini25Pro;

// Cerebras
ExuluDefaultAgents.cerebras.llama3370b;
```

### ExuluContext

Semantic search with vector embeddings for RAG:

```typescript
import { ExuluContext, ExuluEmbedder } from "@exulu/backend";

const embedder = new ExuluEmbedder({
  id: "embedder",
  name: "OpenAI Embedder",
  provider: "openai",
  model: "text-embedding-3-small",
  vectorDimensions: 1536,
  authenticationInformation: process.env.OPENAI_API_KEY
});

const context = new ExuluContext({
  id: "docs",
  name: "Documentation",
  description: "Product documentation",
  embedder,
  tableName: "docs_items",
  fields: [
    { name: "title", type: "string" },
    { name: "url", type: "string" }
  ]
});

// Add documents
await context.addItem({
  content: "Product documentation content...",
  metadata: { title: "Getting Started", url: "https://docs.example.com/start" }
});

// Search (automatically available to agents)
const results = await context.search("How do I get started?", 5);
```

### ExuluTool

Extend agent capabilities with custom functions:

```typescript
import { ExuluTool } from "@exulu/backend";
import { z } from "zod";

const weatherTool = new ExuluTool({
  id: "get_weather",
  name: "Get Weather",
  description: "Get current weather for a location",
  parameters: z.object({
    location: z.string().describe("City name")
  }),
  execute: async ({ location }) => {
    const response = await fetch(`https://api.weather.com/${location}`);
    return await response.json();
  }
});
```

### ExuluDatabase

Initialize database and generate API keys:

```typescript
import { ExuluDatabase } from "@exulu/backend";

// Initialize database with contexts
await ExuluDatabase.init({ contexts: [documentationContext] });

// Generate API key
const { key } = await ExuluDatabase.api.key.generate(
  "Production API",
  "api@example.com"
);
console.log(`API Key: ${key}`);
```

### Background workers

Process long-running tasks with BullMQ:

```typescript
import { ExuluApp } from "@exulu/backend";

const app = new ExuluApp();
await app.create({
  config: {
    workers: { enabled: true }
  },
  // ... agents, contexts, tools
});

// Create worker to process jobs
const worker = await app.bullmq.workers.create();

// Worker automatically processes:
// - Embedding generation
// - Document chunking
// - Scheduled tasks
// - Custom queued jobs
```

## ⚙️ Requirements

- **Node.js**: 22.18.0 (enforced via `engines` in package.json)
- **PostgreSQL**: 13+ with pgvector extension
- **Redis**: Optional, only required if using background workers

## 🗂️ Exulu IMP ecosystem

The Exulu IMP platform consists of multiple repositories working together:

<table>
<tr>
<td width="33%">

**🔧 Backend**
<br/>
[**@exulu/backend**](https://github.com/Qventu/exulu-backend)
<br/>
Core framework with agents, contexts, tools, and API

</td>
<td width="33%">

**🎨 Frontend**
<br/>
[**@exulu/frontend**](https://github.com/Qventu/exulu-frontend)
<br/>
Admin interface for managing agents and workflows

</td>
<td width="33%">

**📦 Example**
<br/>
[**exulu-example**](https://github.com/Qventu/exulu-example)
<br/>
Complete implementation with Docker setup

</td>
</tr>
</table>

### Backend structure

```
@exulu/backend/
├── src/
│   ├── exulu/
│   │   ├── app/           # ExuluApp implementation
│   │   ├── agent.ts       # ExuluAgent class
│   │   ├── context.ts     # ExuluContext class
│   │   ├── tool.ts        # ExuluTool class
│   │   ├── evals.ts       # ExuluEval class
│   │   └── otel.ts        # OpenTelemetry setup
│   ├── auth/              # Authentication utilities
│   ├── bullmq/            # Queue management
│   ├── chunking/          # Text chunking
│   ├── postgres/          # Database client
│   ├── redis/             # Redis client
│   └── templates/         # Default agents
├── types/                 # TypeScript type definitions
└── mintlify-docs/        # Documentation source
```

## 🔐 Authentication

Exulu IMP supports multiple authentication methods:

### API Key authentication

```typescript
import { ExuluAuthentication, postgresClient } from "@exulu/backend";

const { db } = await postgresClient();
const result = await ExuluAuthentication.authenticate({
  apikey: "sk_abc123.../production-api-key",
  db
});

if (!result.error) {
  console.log(`Authenticated as: ${result.user?.email}`);
}
```

### NextAuth session tokens

```typescript
import { getToken } from "next-auth/jwt";

const token = await getToken({ req });
const result = await ExuluAuthentication.authenticate({
  authtoken: token,
  db
});
```

### Internal service keys

```typescript
const result = await ExuluAuthentication.authenticate({
  internalkey: process.env.INTERNAL_SECRET,
  db
});
```

## 📊 Evaluation framework

Test and measure agent performance:

```typescript
import { ExuluEval } from "@exulu/backend";

const evaluation = new ExuluEval({
  id: "accuracy",
  name: "Response Accuracy",
  description: "Measures response accuracy",
  llm: false,
  execute: async ({ messages, testCase }) => {
    const response = messages[messages.length - 1]?.content || "";
    return response === testCase.expected_output ? 100 : 0;
  }
});

const score = await evaluation.run(agent, backend, testCase, messages);
console.log(`Score: ${score}/100`);
```

## 🔬 OpenTelemetry integration

Monitor your application with distributed tracing and logging:

```typescript
import { ExuluOtel } from "@exulu/backend";

const otel = ExuluOtel.create({
  SIGNOZ_TRACES_URL: process.env.SIGNOZ_TRACES_URL!,
  SIGNOZ_LOGS_URL: process.env.SIGNOZ_LOGS_URL!,
  SIGNOZ_ACCESS_TOKEN: process.env.SIGNOZ_ACCESS_TOKEN!
});

otel.start();

// Enable in ExuluApp
await app.create({
  config: {
    telemetry: { enabled: true },
    workers: {
      telemetry: { enabled: true },
      enabled: true
    }
  }
});
```

## 🌍 Environment variables

Create a `.env` file with:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/exulu

# NextAuth
NEXTAUTH_SECRET=your-secret-key

# Redis (optional, for workers)
REDIS_HOST=localhost
REDIS_PORT=6379

# S3 Storage (optional, for file uploads)
COMPANION_S3_REGION=us-east-1
COMPANION_S3_KEY=your-key
COMPANION_S3_SECRET=your-secret
COMPANION_S3_BUCKET=exulu-uploads
COMPANION_S3_ENDPOINT=https://s3.amazonaws.com

# OpenTelemetry (optional)
SIGNOZ_TRACES_URL=http://localhost:4318/v1/traces
SIGNOZ_LOGS_URL=http://localhost:4318/v1/logs
SIGNOZ_ACCESS_TOKEN=your-token
```

## 📦 Complete example

For a **production-ready implementation**, see the [Exulu Example Repository](https://github.com/Qventu/exulu-example):

```bash
git clone https://github.com/Qventu/exulu-example.git
cd exulu-example
npm install
docker compose up -d
npm run utils:initdb
npm run dev:server
```

The example includes:
- ✅ Docker Compose for all services
- ✅ Database initialization
- ✅ Pre-configured agents
- ✅ Context examples
- ✅ Custom tools
- ✅ Worker implementation
- ✅ Environment templates

**Add the admin frontend:**

```bash
# In a new terminal window
npx @exulu/frontend
```

Visit `http://localhost:3001` to access the admin interface. See the [**Exulu Frontend**](https://github.com/Qventu/exulu-frontend) repository for more details.

## 🛠️ Development

```bash
# Install dependencies
npm install

# Build package
npm run build

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format

# Type check
npm run type-check
```

## 📚 Examples

### RAG application

```typescript
const context = new ExuluContext({
  id: "knowledge",
  name: "Knowledge Base",
  description: "Company knowledge base",
  embedder,
  tableName: "knowledge_items"
});

const agent = new ExuluAgent({
  id: "rag-agent",
  name: "RAG Assistant",
  provider: "anthropic",
  config: {
    instructions: "Answer questions using the knowledge base.",
    model: { create: ({ apiKey }) => anthropic("claude-sonnet-4-5", apiKey) }
  }
});

await app.create({
  agents: [agent],
  contexts: { knowledge: context }
});

// Agent automatically searches context when answering
```

### Multi-agent workflow

```typescript
const researchAgent = new ExuluAgent({
  id: "researcher",
  name: "Research Agent",
  provider: "openai",
  config: { /* ... */ }
});

const writerAgent = new ExuluAgent({
  id: "writer",
  name: "Writer Agent",
  provider: "anthropic",
  config: { /* ... */ }
});

await app.create({
  agents: [researchAgent, writerAgent],
  contexts: {},
  tools: [webSearchTool, documentTool]
});
```

### Custom tool with API integration

```typescript
const slackTool = new ExuluTool({
  id: "send_slack_message",
  name: "Send Slack Message",
  description: "Send a message to a Slack channel",
  parameters: z.object({
    channel: z.string(),
    message: z.string()
  }),
  execute: async ({ channel, message }) => {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SLACK_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ channel, text: message })
    });
    return await response.json();
  }
});
```

## 🚨 Need help?

- 📖 **[Documentation](https://docs.exulu.com)** - Comprehensive guides and API reference
- 💬 **[Discord](https://discord.com/channels/936044636693221439)** - Join our community
- 🐛 **[GitHub Issues](https://github.com/Qventu/exulu-backend/issues)** - Report bugs
- 💡 **[GitHub Discussions](https://github.com/Qventu/exulu-backend/discussions)** - Ask questions

## 🗺️ Roadmap

Check out our [Roadmap Discussion](https://github.com/Qventu/exulu-backend/discussions/2) to see what we're working on and suggest features.

## 📄 License

This project is licensed under a **commercial license**. See [exulu.com](https://exulu.com) for licensing information.

The [Exulu Example Project](https://github.com/Qventu/exulu-example) is open source under the MIT License.

## 🌟 Related projects

<table>
<tr>
<td width="50%" align="center">

### [**Exulu Frontend** →](https://github.com/Qventu/exulu-frontend)
<a href="https://github.com/Qventu/exulu-frontend">
  <img src="https://img.shields.io/github/stars/Qventu/exulu-frontend?style=social" alt="GitHub stars" />
</a>
<br/>
<br/>
Modern admin interface built with Next.js 15
<br/>
Manage agents, contexts, and workflows visually

</td>
<td width="50%" align="center">

### [**Exulu Example** →](https://github.com/Qventu/exulu-example)
<a href="https://github.com/Qventu/exulu-example">
  <img src="https://img.shields.io/github/stars/Qventu/exulu-example?style=social" alt="GitHub stars" />
</a>
<br/>
<br/>
Complete implementation example
<br/>
Docker setup with all services configured

</td>
</tr>
</table>

## ⭐ Star us on GitHub

If you find Exulu IMP useful, give us a star! It helps others discover the project.

<a href="https://star-history.com/#Qventu/exulu-backend&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Qventu/exulu-backend&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Qventu/exulu-backend&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Qventu/exulu-backend&type=Date" />
  </picture>
</a>

## 👏 Thanks to all our contributors

<img align="left" src="https://contributors-img.web.app/image?repo=Qventu/exulu-backend"/>

<br clear="left"/>

---

<div align="center">

**Exulu IMP** - Intelligence Management Platform

Made with ❤️ by [Qventu](https://qventu.com)

[Website](https://exulu.com) · [Documentation](https://docs.exulu.com) · [Frontend](https://github.com/Qventu/exulu-frontend) · [Discord](https://discord.com/channels/936044636693221439)

</div>
