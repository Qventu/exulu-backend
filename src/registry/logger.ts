import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport'
import winston from 'winston'

const createLogger = ({
    enableOtel
}: {
    enableOtel: boolean,
}) => {
    const logger = winston.createLogger({
        level: 'debug',
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({
                stack: true
            }),
            winston.format.metadata(),
            winston.format.json()
        ),
        defaultMeta: {
            service: 'Exulu',
            environment: process.env.NODE_ENV || 'development',
        },
        transports: [
            new winston.transports.Console(),
            ...(enableOtel ? [new OpenTelemetryTransportV3()] : []),
        ],
    })
    return logger;
}

export default createLogger;

