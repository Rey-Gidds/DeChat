import { createAuthClient } from "better-auth/react";

// In the browser we resolve against the current origin so the auth client
// always points to the same host that served the page — no hard-coded URL
// that could be baked at build time with the wrong value.
const baseURL =
  typeof window !== "undefined"
    ? window.location.origin
    : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const authClient = createAuthClient({
  baseURL,
  basePath: "/api/auth",
});

export const { signIn, signUp, useSession, signOut, requestPasswordReset, resetPassword, verifyEmail, getSession, sendVerificationEmail } = authClient;
