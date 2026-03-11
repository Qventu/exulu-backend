import { OpenTelemetryTransportV3 } from "@opentelemetry/winston-transport";
import winston, { type transport } from "winston";

const createLogger = ({
  enableOtel,
  transports,
}: {
  enableOtel: boolean;
  transports: transport[];
}) => {
  const logger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({
        stack: true,
      }),
      winston.format.metadata(),
      winston.format.json(),
    ),
    defaultMeta: {
      service: "Exulu",
      environment: process.env.NODE_ENV || "development",
    },
    transports: [...transports, ...(enableOtel ? [new OpenTelemetryTransportV3()] : [])],
  });
  return logger;
};

export default createLogger;
