// lib/email.ts
import { ExuluTool } from '@SRC/exulu/tool';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { z } from 'zod';

let transporter: Transporter | null = null;

/**
 * Get or create email transporter instance
 */
function getTransporter(config: Record<string, any>): Transporter {
    if (!transporter) {
        transporter = nodemailer.createTransport(config);
    }
    return transporter;
}

export async function sendEmail(
    recipient: string,
    subject: string,
    html: string,
    text: string,
    config: Record<string, any>
): Promise<void> {
    const transport = getTransporter(config);

    html = html.trim();
    text = text.trim();

    await transport.sendMail({
        from: config.from,
        to: recipient,
        subject,
        text,
        html,
    });
}

export const emailTool = new ExuluTool({
    id: "email",
    name: "Email",
    description: "Send an email.",
    inputSchema: z.object({
        recipient: z.string().describe("The recipient of the email."),
        subject: z.string().describe("The subject of the email."),
        html: z.string().describe("The HTML body of the email."),
        text: z.string().describe("The text body of the email."),
    }),
    type: "function",
    config: [{
        name: "smtp_host",
        description: "The SMTP host to send the email from.",
        type: "variable",
        default: undefined
    }, {
        name: "smtp_port",
        description: "The SMTP port to send the email from.",
        type: "variable",
        default: undefined
    }, {
        name: "smtp_user",
        description: "The SMTP user to send the email from.",
        type: "variable",
        default: undefined
    }, {
        name: "smtp_password",
        description: "The SMTP password to send the email from.",
        type: "variable",
        default: undefined
    }, {
        name: "smtp_from",
        description: "The SMTP from address to send the email from.",
        type: "variable",
        default: undefined
    }, {
        name: "allowed_recipient_domains",
        description: "A comma seperated list of allowed recipient domains to send emails to.",
        type: "string",
        default: undefined
    }],
    execute: async ({ recipient, subject, html, text, toolVariablesConfig }) => {

        // Email configuration from environment variables
        const EMAIL_CONFIG = {
            host: toolVariablesConfig.smtp_host || process.env.SMTP_HOST || '',
            port: parseInt(toolVariablesConfig.smtp_port || process.env.SMTP_PORT || '587', 10),
            secure: toolVariablesConfig.smtp_secure === 'true' || process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            auth: {
                user: toolVariablesConfig.smtp_user || process.env.SMTP_USER || '',
                pass: toolVariablesConfig.smtp_password || process.env.SMTP_PASSWORD || '',
            },
            from: toolVariablesConfig.smtp_from || process.env.SMTP_FROM || '',
            // Allow self-signed certificates if SMTP_REJECT_UNAUTHORIZED is set to 'false'
            tls: {
                rejectUnauthorized: false
            },
        };

        if (toolVariablesConfig.allowed_recipient_domains) {
            const allowedRecipientDomains = toolVariablesConfig.allowed_recipient_domains.split(",");
            if (!allowedRecipientDomains.some(domain => recipient.endsWith(`@${domain}`))) {
                return {
                    result: "Recipient domain not allowed to send emails to."
                };
            }
        }

        await sendEmail(recipient, subject, html, text, EMAIL_CONFIG);

        return {
            result: "Email sent successfully to " + recipient + " with subject " + subject + "."
        };
    }
});