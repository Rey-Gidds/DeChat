import type { CryptoEnvelope, RecoveryKeyEnvelope } from "@/lib/crypto";

export interface KeyEnvelopeRecord {
  configured: boolean;
  version: number | null;
  updatedAt: string | null;
  keyEnvelope: CryptoEnvelope | null;
  recoveryEnvelope: RecoveryKeyEnvelope | null;
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Encryption request failed");
  return data as T;
}

export function fetchKeyEnvelope(): Promise<KeyEnvelopeRecord> {
  return request<KeyEnvelopeRecord>("/api/me/keys");
}

export function createKeyEnvelope(input: {
  publicKey: string;
  keyEnvelope: CryptoEnvelope;
  recoveryEnvelope: RecoveryKeyEnvelope;
}): Promise<{ ok: true; version: number }> {
  return request("/api/me/keys", { method: "POST", body: JSON.stringify(input) });
}

export function replaceKeyEnvelope(input: {
  publicKey: string;
  keyEnvelope: CryptoEnvelope;
  recoveryEnvelope: RecoveryKeyEnvelope;
  expectedVersion: number;
}): Promise<{ ok: true; version: number }> {
  return request("/api/me/keys", { method: "PUT", body: JSON.stringify(input) });
}
