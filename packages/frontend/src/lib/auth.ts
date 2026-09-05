import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { sendEmail } from "./email";
import { ensureMongoConnected, getDb } from "./mongodb";

export const db = getDb();

export const auth = betterAuth({
    database: mongodbAdapter(db, {
        transaction: false,
    }),
    // BETTER_AUTH_URL is the canonical server-side variable and is NOT baked at
    // build time (unlike NEXT_PUBLIC_ vars). On Vercel, set this to your
    // production URL (e.g. https://your-app.vercel.app).
    baseURL: process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    trustHost: true,
    basePath: "/api/auth",
    secret: process.env.BETTER_AUTH_SECRET,
    advanced: {
        // Required when the app is served over HTTPS behind a proxy (Vercel/Render)
        // and the cookie must be sent cross-context. Without this, the session
        // cookie is scoped with sameSite:"lax" and may not be returned to the
        // API, causing 401 on every protected route in production.
        defaultCookieAttributes: {
            sameSite: "none",
            secure: true,
        },
    },
    session: {
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
        cookieCache: {
            enabled: false,
        },
    },
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
        sendResetPassword: async ({ user, token }) => {
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000";
            const cleanBaseUrl = baseUrl.replace(/\/$/, "");
            const url = `${cleanBaseUrl}/reset-password?token=${token}`;
            
            if (process.env.NODE_ENV === "development") {
                console.log(`\n\n🔑 PASSWORD RESET LINK: ${url}\n\n`);
            }

            await sendEmail({
                to: user.email,
                subject: "Reset your password",
                html: `<p>Click <a href="${url}">here</a> to reset your password. The link will expire in 1 hour.</p><p>If the link doesn't work, copy and paste this direct URL: ${url}</p>`,
            });
        },
    },
    account: {
        storeStateStrategy: "cookie",
    },
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID || "dummy_google_client_id",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "dummy_google_client_secret",
            redirectURI: `${(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/auth/callback/google`,
        }
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, token }) => {
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000";
            const cleanBaseUrl = baseUrl.replace(/\/$/, "");
            const url = `${cleanBaseUrl}/verify-email?token=${token}`;
            
            if (process.env.NODE_ENV === "development") {
                console.log(`\n\n📧 EMAIL VERIFICATION LINK: ${url}\n\n`);
            }

            await sendEmail({
                to: user.email,
                subject: "Verify your email",
                html: `<p>Click <a href="${url}">here</a> to verify your email address. The link will expire in 24 hours.</p><p>If the link doesn't work, copy and paste this direct URL: ${url}</p>`,
            });
        },
    },
    user: {
        additionalFields: {
            publicKey: {
                type: "string",
                required: false,
            },
            // Stores PfpMetadata object; was formerly a base64 string
            pfp: {
                type: "json",
                required: false,
            },
            encryptionEnabled: {
                type: "boolean",
                required: false,
            },
            // Set to true during migration so the client can prompt re-upload
            pfpNeedsReupload: {
                type: "boolean",
                required: false,
            },
        },
    },
});

export { ensureMongoConnected };
