# Exulu

A comprehensive TypeScript package providing integrations and utilities for modern web applications.

## Features

- 🔐 Authentication and Authorization
- 🗄️ Database Integrations (PostgreSQL with pgvector support)
- 🔄 Redis Integration
- 📊 BullMQ Queue Management
- 🤖 AI and RAG (Retrieval-Augmented Generation) Capabilities
- 📝 GraphQL Support with Apollo Server
- 🔄 Express Integration
- 📦 AWS S3 Integration
- 🔒 JWT and NextAuth Support

## Installation

```bash
npm install exulu
```

## Quick Start

```typescript
import { /* your imports */ } from 'exulu';

// Your implementation here
```

## Dependencies

This package requires the following peer dependencies:
- TypeScript ^5.8.3

## Development

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Build the package:
```bash
npm run build
```

## Project Structure

```
src/
├── auth.ts           # Authentication utilities
├── core-schema.ts    # Core GraphQL schema definitions
├── types/           # TypeScript type definitions
├── registry/        # Registry related functionality
├── postgres/        # PostgreSQL database integrations
├── redis/           # Redis client and utilities
├── bullmq/          # Queue management
├── mcp/             # MCP related functionality
├── chunking/        # Data chunking utilities
└── evals/           # Evaluation utilities
```

## License

Private - Qventu Bv.

## Author

Qventu Bv.
