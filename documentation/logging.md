# Winston Logger Implementation

This document describes how winston logging has been integrated into the Exulu backend across Express server, MCP server, and worker instances.

## Architecture Overview

The logging system is centralized through a logger factory function in `src/registry/logger.ts` that creates winston logger instances with conditional OpenTelemetry integration.

## Logger Configuration

### Core Logger Setup (`src/registry/logger.ts`)

The `createLogger` function accepts an `enableOtel` boolean parameter to conditionally enable OpenTelemetry transport:

```typescript
const createLogger = ({ enableOtel }: { enableOtel: boolean }) => {
    const logger = winston.createLogger({
        level: 'debug',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.metadata(),
            winston.format.json()
        ),
        defaultMeta: {
            service: 'Test-Exulu',
            environment: process.env.NODE_ENV || 'development',
        },
        transports: [
            new winston.transports.Console(),
            ...(enableOtel ? [new OpenTelemetryTransportV3()] : []),
        ],
    })
    return logger;
}
```

### Configuration-Driven Telemetry

The ExuluApp class manages telemetry configuration through the `ExuluConfig` type:

```typescript
export type ExuluConfig = {
    telemetry?: {
        enabled: boolean,
    }
    workers: {
        enabled: boolean,
        logsDir?: string,
        telemetry?: {
            enabled: boolean,
        }
    }
    // ...
}
```

## Integration Points

### 1. Express Server Logging

In `src/registry/index.ts:154-156`, the Express server creates a logger instance:

```typescript
const logger = createLogger({
    enableOtel: this._config?.telemetry?.enabled ?? false
})
```

The logger is then passed to `createExpressRoutes()` for use throughout the Express application.

### 2. BullMQ Workers Logging  

In `src/registry/index.ts:123-125`, workers create their own logger instance:

```typescript
const logger = createLogger({
    enableOtel: this._config?.workers?.telemetry?.enabled ?? false
})
```

Workers have separate telemetry configuration allowing independent control of logging transport.

### 3. MCP Server Logging

The MCP server receives the logger instance via dependency injection in `src/mcp/index.ts:31`:

```typescript
create = async ({ express, contexts, agents, config, tools, tracer, logger }: {
    // ... other params
    logger: Logger
}) => {
    // Logger is passed in and used throughout MCP server
}
```

## Features

- **Structured JSON Logging**: All logs are formatted as JSON with timestamps and metadata
- **Error Stack Traces**: Automatic stack trace capture for error objects
- **Environment Context**: Automatic service name and environment labeling
- **Conditional OpenTelemetry**: OTel transport enabled based on configuration
- **Console Fallback**: Always includes console transport for development
- **Instance-Level Control**: Express, Workers, and MCP can have independent telemetry settings

## Usage

Configure telemetry in your ExuluApp config:

```typescript
const config: ExuluConfig = {
    telemetry: {
        enabled: true  // Enables OTel for Express and MCP
    },
    workers: {
        enabled: true,
        telemetry: {
            enabled: false  // Workers use console-only logging
        }
    }
}
```