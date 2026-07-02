import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null = null;
let verifiedOnce = false;

function getTransporter(): nodemailer.Transporter {
    if (transporter) return transporter;

    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
        throw new Error(
            "EMAIL_USER and EMAIL_PASS must be set to send emails (see .env.example)."
        );
    }

    transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user, pass },
    });

    return transporter;
}

export const sendEmail = async ({
    to,
    subject,
    html,
}: {
    to: string;
    subject: string;
    html: string;
}) => {
    const from = process.env.EMAIL_FROM || "dechat <reygidwani2006@gmail.com>";
    
    try {
        const mailer = getTransporter();

        if (!verifiedOnce && process.env.NODE_ENV === "development") {
            verifiedOnce = true;
            await mailer.verify();
            console.log("[email] SMTP transporter verified");
        }

        await mailer.sendMail({
            from,
            to,
            subject,
            html,
        });
        console.log(`[email] ✅ Email sent successfully to ${to}`);
    } catch (error) {
        console.error("[email] ❌ Failed to send email:", error);

        if (process.env.NODE_ENV === "development") {
            // In development, swallow SMTP errors so signup/password-reset flows
            // can still complete. The verification / reset URL is logged by auth.ts.
            console.warn(
                "[email] ⚠️  DEV MODE — SMTP failed. Email was NOT delivered.\n" +
                "  If you are using Gmail, EMAIL_PASS must be a 16-character App Password,\n" +
                "  NOT your regular Gmail password.\n" +
                "  Generate one at: https://myaccount.google.com/apppasswords\n" +
                "  Until then, copy the URL from the log above to test the flow manually."
            );
            return; // Don't throw — let the auth flow complete
        }

        throw error;
    }
};
