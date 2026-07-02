import { MongoClient, type Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is not defined in environment variables.");
}

const DB_NAME = process.env.MONGODB_DB_NAME || "dechat";

type MongoGlobal = typeof globalThis & {
  __mongoClient?: MongoClient;
  __mongoClientPromise?: Promise<MongoClient>;
};

const globalMongo = global as MongoGlobal;

function startConnection(): Promise<MongoClient> {
  const client = new MongoClient(MONGODB_URI!);
  globalMongo.__mongoClient = client;
  globalMongo.__mongoClientPromise = client.connect();
  return globalMongo.__mongoClientPromise;
}

function getConnectionPromise(): Promise<MongoClient> {
  if (!globalMongo.__mongoClientPromise) {
    return startConnection();
  }
  return globalMongo.__mongoClientPromise;
}

/** Ensures MongoDB is connected; reconnects after dev HMR closes the topology. */
export async function ensureMongoConnected(): Promise<MongoClient> {
  try {
    const client = await getConnectionPromise();
    await client.db(DB_NAME).command({ ping: 1 });
    return client;
  } catch {
    if (globalMongo.__mongoClient) {
      await globalMongo.__mongoClient.close().catch(() => undefined);
    }
    globalMongo.__mongoClient = undefined;
    globalMongo.__mongoClientPromise = undefined;
    const client = await startConnection();
    await client.db(DB_NAME).command({ ping: 1 });
    return client;
  }
}

export function getDb(): Db {
  if (!globalMongo.__mongoClient) {
    globalMongo.__mongoClient = new MongoClient(MONGODB_URI!);
    globalMongo.__mongoClientPromise = globalMongo.__mongoClient.connect();
  }
  return globalMongo.__mongoClient.db(DB_NAME);
}

// Start connection as soon as the module loads (Next.js server).
void getConnectionPromise().catch((err) => {
  console.error("[mongodb] Initial connection failed:", err.message);
});
