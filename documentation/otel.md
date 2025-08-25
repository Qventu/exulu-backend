# OpenTelemetry (OTEL) Implementation

## Overview

Exulu has built-in OpenTelemetry support for distributed tracing and logging. OTEL can be enabled/disabled individually for different components (workers, MCP, and Express server) through configuration.

**Current Support**: The implementation currently supports SigNoz (both Cloud and self-hosted) as the observability backend. Future versions may include support for other OTEL-compatible backends.

## Architecture

### Core Components

1. **ExuluOtel Class** (`src/registry/otel.ts`)
   - Factory function that creates a NodeSDK instance
   - Configures trace and log exporters for SigNoz
   - Sets up automatic instrumentation
   - Handles graceful shutdown

2. **Configuration** (`src/registry/index.ts`)
   - Telemetry can be enabled at the app level and component level
   - Each component (workers, MCP, Express) has individual telemetry controls

## Usage

### Basic Setup

```typescript
import { ExuluOtel } from "@exulu/backend";

const otel = ExuluOtel.create({
    SIGNOZ_TRACES_URL: process.env.SIGNOZ_TRACES_URL!,
    SIGNOZ_LOGS_URL: process.env.SIGNOZ_LOGS_URL!,
    SIGNOZ_ACCESS_TOKEN: process.env.SIGNOZ_ACCESS_TOKEN!
});

otel.start();
```

### Configuration

```typescript
const config: ExuluConfig = {
    telemetry: {
        enabled: true  // Global telemetry switch
    },
    workers: {
        enabled: true,
        telemetry: {
            enabled: true  // Worker-specific telemetry
        }
    },
    MCP: {
        enabled: true
        // MCP uses global telemetry setting
    }
};
```

## Implementation Details

### Trace Generation

When telemetry is enabled, Exulu automatically generates trace spans for:

- **Express Server Routes** (`src/registry/routes.ts:166`)
- **BullMQ Workers** (`src/registry/workers.ts:133`) 
- **MCP Operations** (`src/registry/index.ts:176`)

### Tracer Initialization

```typescript
// Tracer is created when telemetry is enabled
let tracer: Tracer | undefined;
if (config?.telemetry?.enabled) {
    tracer = trace.getTracer("exulu", "1.0.0");
}
```

### SigNoz Integration

The current implementation is specifically designed for SigNoz integration (supports both SigNoz Cloud and self-hosted deployments):

- **Service Name**: `Test-Exulu`
- **Traces**: Exported to `SIGNOZ_TRACES_URL`
- **Logs**: Exported to `SIGNOZ_LOGS_URL` 
- **Authentication**: Uses `signoz-access-token` header
- **Protocol**: OTLP over HTTP with SigNoz-specific headers

### Auto-Instrumentation

Uses `@opentelemetry/auto-instrumentations-node` for automatic instrumentation of:
- HTTP requests/responses
- Database queries
- File system operations
- And more Node.js modules

### Graceful Shutdown

OTEL SDK automatically shuts down on `SIGTERM` signal:

```typescript
process.on('SIGTERM', () => {
    sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error) => console.log('Error terminating tracing', error))
        .finally(() => process.exit(0));
});
```

## Environment Variables

Required environment variables for SigNoz integration:

- `SIGNOZ_TRACES_URL`: URL for trace export
- `SIGNOZ_LOGS_URL`: URL for log export  
- `SIGNOZ_ACCESS_TOKEN`: Authentication token

## Component-Level Control

### Workers
- Controlled by `config.workers.telemetry.enabled`
- Creates tracer instance when enabled
- Passes tracer to worker creation

### Express Server
- Controlled by `config.telemetry.enabled` 
- Creates tracer for route instrumentation
- Integrates with logger for structured logging

### MCP Server
- Uses global `config.telemetry.enabled` setting
- Receives tracer instance from parent ExuluApp
- Traces MCP protocol operations

## Logger Integration

Each component creates an OTEL-aware logger:

```typescript
const logger = createLogger({
    enableOtel: config?.telemetry?.enabled ?? false
});
```

This enables correlation between traces and structured logs.