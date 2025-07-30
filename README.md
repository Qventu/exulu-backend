# Exulu - AI Agent Management Platform

<div align="center">

![Exulu Logo](frontend/public/exulu_logo.svg)

**A powerful platform for creating, managing, and orchestrating AI agents with enterprise-grade features**

[![Node.js](https://img.shields.io/badge/Node.js-20.10.0-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Private-red.svg)](LICENSE)

</div>

## 🚀 Overview

Exulu is a comprehensive AI agent management platform that enables you to create, deploy, and orchestrate intelligent agents with enterprise-grade features. Built with TypeScript, it provides a robust backend infrastructure and modern frontend interface for seamless agent management and interaction.

### Key Features

- 🤖 **AI Agent Management**: Create and manage multiple AI agents with different capabilities
- 🔧 **Tool Integration**: Extend agent capabilities with custom tools and workflows
- 🗄️ **Vector Database**: PostgreSQL with pgvector for semantic search and RAG
- 📊 **Queue Management**: BullMQ for background job processing
- 🔐 **Authentication**: JWT and NextAuth support with role-based access
- 📝 **GraphQL API**: Flexible API with Apollo Server integration
- 🎯 **Agent Evaluation**: Built-in evaluation framework for agent performance
- 🔄 **Workflow Orchestration**: Create complex multi-agent workflows
- 📦 **File Management**: S3-compatible storage with Uppy integration
- 🎨 **Modern UI**: Next.js frontend.

## 🏗️ Architecture

The overall project is organized into 5 main repositories:


1. Backend: Express.js server with endpoints for agents, contexts, jobs, users, roles and workflows.
2. Frontend: Next.js application.
3. Example: example Exulu implementation with example agents, contexts and tools.
4. CLI: command-line interface tools.
5. Tools: catalogue of ExuluTools that can be installed and added to agents.
6. Agents: catalogue of template agents you can install and add to your Exulu instance.

### Core Components

- **ExuluApp**: Main application class that initializes the platform
- **Agents**: AI agent definitions with configurable capabilities
- **Tools**: Available actions and utilities for agents
- **Contexts**: Vectorized knowledge sources agents can search through and use in their reasoning and response
- **Workflows**: Predefined agent interaction patterns
- **Embedders**: Text embedding models for semantic search

## 🛠️ Prerequisites

- **Node.js** (v20.10.0 or higher)
- **PostgreSQL** with pgvector extension
- **Redis** (optional, for BullMQ workers)
- **Docker** (optional, for containerized deployment)

## 📚 Usage Examples

### Creating an Agent

```typescript
import { ExuluApp, ExuluAgent } from "@exulu/backend";

const exulu = new ExuluApp();

const myAgent = new ExuluAgent({
  id: "my-custom-agent",
  name: "My Custom Agent",
  description: "A custom AI agent for specific tasks",
  type: "agent",
  capabilities: {
    tools: true,
    images: [],
    files: [],
    audio: [],
    video: []
  },
  config: {
    model: "gpt-4",
    // ... other configuration
  }
});

const server = await exulu.create({
  config: {
    workers: { enabled: false },
    MCP: { enabled: true }
  },
  contexts: [],
  tools: [],
  agents: [myAgent],
  workflows: []
});
```

### Using the CLI

```bash
# Install CLI globally
npm install -g @exulu/cli

# Run CLI
exulu

# Available commands:
# - Start Claude Code
# - List agents
# - List contexts
```

## 🔧 Configuration

### Environment Variables

Create `.env` files in both `frontend/` and `backend/` directories. Use the `.env.preview` files for reference.

#### Backend Environment Variables

```env
# Database
DATABASE_URL=postgresql://username:password@localhost:5432/exulu
REDIS_URL=redis://localhost:6379

# Authentication
JWT_SECRET=your-jwt-secret
NEXTAUTH_SECRET=your-nextauth-secret

# AI Providers
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key

# File Storage
S3_BUCKET=your-s3-bucket
S3_REGION=your-s3-region
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
```

#### Frontend Environment Variables

```env
# API Configuration
NEXT_PUBLIC_API_URL=http://localhost:9001
NEXT_PUBLIC_GRAPHQL_URL=http://localhost:9001/graphql

# Authentication
NEXTAUTH_URL=http://localhost:3020
NEXTAUTH_SECRET=your-nextauth-secret
```

### Development Guidelines

- Follow TypeScript best practices
- Use conventional commits
- Write comprehensive tests
- Update documentation
- Follow the existing code style

## 📄 License

This project is licensed under a private license - see the [LICENSE](LICENSE) file for details.

## 👥 Authors

- **Qventu Bv.** - *Initial work*

---

<div align="center">

**Exulu** - Intelligence Management Platform

</div>