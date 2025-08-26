import process from 'process';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';


const create = ({
    SIGNOZ_ACCESS_TOKEN,
    SIGNOZ_TRACES_URL,
    SIGNOZ_LOGS_URL
}: {
    SIGNOZ_ACCESS_TOKEN: string;
    SIGNOZ_TRACES_URL: string;
    SIGNOZ_LOGS_URL: string;
}) => {

    console.log("[EXULU] Setting up OpenTelemetry")
    // do not set headers in exporterOptions, the OTel spec recommends setting headers through ENV variables
    // https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/protocol/exporter.md#specifying-headers-via-environment-variables

    // highlight-start
    const exporterOptions = {
        url: SIGNOZ_TRACES_URL,
        headers: {
            "signoz-access-token": SIGNOZ_ACCESS_TOKEN
        }
    }

    const traceExporter = new OTLPTraceExporter(exporterOptions);
    const logExporter = new OTLPLogExporter({
        url: SIGNOZ_LOGS_URL,
        headers: {
            'signoz-access-token': SIGNOZ_ACCESS_TOKEN,
        },
    });

    const sdk = new NodeSDK({
        traceExporter,
        logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
        instrumentations: [getNodeAutoInstrumentations()],
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: 'Exulu'
        })
    });

    // gracefully shut down the SDK on process exit
    process.on('SIGTERM', () => {
        sdk.shutdown()
            .then(() => console.log('Tracing terminated'))
            .catch((error) => console.log('Error terminating tracing', error))
            .finally(() => process.exit(0));
    });

    return sdk;
}

export { create }