import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import worker from "../index.ts";

type Write = { op: "put" | "delete"; key: string };

class MemoryKV {
  private values = new Map<string, string>();
  readonly writes: Write[] = [];

  seed(key: string, value: string) {
    this.values.set(key, value);
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
    this.writes.push({ op: "put", key });
  }

  async delete(key: string) {
    this.values.delete(key);
    this.writes.push({ op: "delete", key });
  }

  async list(options: { prefix?: string; cursor?: string } = {}) {
    const prefix = options.prefix ?? "";
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
      cacheStatus: null,
    };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  path: string,
  env: Record<string, unknown>,
  init?: RequestInit,
) {
  const context = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as ExecutionContext;

  return worker.fetch(
    new Request(`http://worker.test${path}`, init),
    env as Env,
    context,
  );
}

const kv = new MemoryKV();
const env = {
  BRO_KV: kv,
  SENDER: "sender@example.com",
  BASE_URL: "http://worker.test",
};

const realFetch = globalThis.fetch;
let currentHash = "";
let currentText = "";

try {
  const inspectResponse = await request("/check", env);
  assert(inspectResponse.ok, `GET /check failed: ${inspectResponse.status}`);

  const inspectBody = (await inspectResponse.json()) as any;
  assert(inspectBody.status === "ok", "GET /check did not return status=ok");
  assert(
    typeof inspectBody.bulletin?.hash === "string",
    "GET /check did not return a bulletin hash",
  );
  assert(
    typeof inspectBody.bulletin?.text === "string",
    "GET /check did not return bulletin text",
  );

  currentHash = inspectBody.bulletin.hash;
  currentText = inspectBody.bulletin.text;

  assert(
    kv.writes.length === 0,
    `GET /check mutated KV: ${JSON.stringify(kv.writes)}`,
  );

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url.includes("mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py")) {
      return new Response(currentText, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return realFetch(input, init);
  };

  const replayWritesBefore = kv.writes.length;
  const replayResponse = await request("/check", env);
  assert(replayResponse.ok, "replayed GET /check failed");
  const replayBody = (await replayResponse.json()) as any;
  assert(replayBody.status === "ok", "replayed GET /check did not return status=ok");
  currentHash = replayBody.bulletin.hash;
  assert(
    kv.writes.length === replayWritesBefore,
    "replayed GET /check mutated KV",
  );

  for (const path of ["/check/raw", "/check/html", "/status"]) {
    const before = kv.writes.length;
    const response = await request(path, env);
    assert(response.ok, `GET ${path} failed: ${response.status}`);
    assert(
      kv.writes.length === before,
      `GET ${path} mutated KV: ${JSON.stringify(kv.writes.slice(before))}`,
    );
  }

  kv.seed(
    "AFDBRO:last",
    JSON.stringify({
      hash: currentHash,
      seenAt: "2026-09-24T12:00:00.000Z",
    }),
  );
  kv.seed(
    "SUBS:e2e",
    JSON.stringify({
      email: "e2e@example.com",
      createdAt: "2026-09-24T12:00:00.000Z",
      lastSentHash: "stale-hash",
      lastSentAt: null,
      verified: true,
      disabled: false,
      unsubToken: "u_e2e",
    }),
  );

  const preflightWritesBefore = kv.writes.length;
  const preflightResponse = await request("/check", env);
  assert(preflightResponse.ok, "preflight GET /check failed");
  const preflightBody = (await preflightResponse.json()) as any;
  assert(
    preflightBody.bulletin?.changedSinceLastDelivery === false,
    `fixture did not establish unchanged global state: ${JSON.stringify(preflightBody.bulletin)}`,
  );
  assert(
    kv.writes.length === preflightWritesBefore,
    "preflight GET /check mutated KV",
  );

  const writesBeforeDelivery = kv.writes.length;
  const deliveryResponse = await request("/check", env, { method: "POST" });
  assert(
    deliveryResponse.ok,
    `POST /check failed: ${deliveryResponse.status}`,
  );

  const deliveryBody = (await deliveryResponse.json()) as any;
  assert(
    deliveryBody.bulletin?.changedSinceLastDelivery === false,
    "POST /check did not reproduce an unchanged global bulletin",
  );
  assert(
    deliveryBody.delivery?.attempted === 1,
    `POST /check skipped the stale subscriber: ${JSON.stringify(deliveryBody.delivery)}`,
  );
  assert(
    deliveryBody.delivery?.sent === 0,
    "E2E unexpectedly sent an email",
  );
  assert(
    deliveryBody.delivery?.issues?.includes("smtp_not_configured"),
    "E2E did not stay on the no-SMTP path",
  );

  const deliveryWrites = kv.writes.slice(writesBeforeDelivery);
  assert(
    deliveryWrites.some((write) => write.key === "AFDBRO:last"),
    "POST /check did not update AFDBRO:last",
  );
  assert(
    deliveryWrites.some((write) => write.key === "AFDBRO:delivery:last"),
    "POST /check did not persist delivery status",
  );

  const writesBeforeFinalInspect = kv.writes.length;
  const finalInspect = await request("/check", env);
  assert(finalInspect.ok, "final GET /check failed");
  assert(
    kv.writes.length === writesBeforeFinalInspect,
    "GET /check mutated KV after a delivery run",
  );

  const statusResponse = await request("/status", env);
  assert(statusResponse.ok, "GET /status failed");
  const statusBody = (await statusResponse.json()) as any;
  assert(
    statusBody.lastBulletin?.hash === currentHash,
    "GET /status did not expose the last delivery hash",
  );
  assert(
    statusBody.lastDelivery?.attempted === 1,
    "GET /status did not expose the delivery summary",
  );

  const artifact = {
    test: "notification-state-e2e",
    passed: true,
    source: inspectBody.bulletin.sourceUrl,
    currentHash,
    readOnlyKvWrites: 0,
    unchangedGlobalHash: true,
    staleSubscriberAttempted: deliveryBody.delivery.attempted,
    emailsSent: deliveryBody.delivery.sent,
    deliveryIssues: deliveryBody.delivery.issues,
    persistedKeys: deliveryWrites.map((write) => write.key),
    completedAt: new Date().toISOString(),
  };

  const artifactPath =
    process.env.E2E_ARTIFACT ?? "artifacts/e2e-notification-state.json";
  await mkdir(dirname(artifactPath), { recursive: true });
  await Bun.write(artifactPath, JSON.stringify(artifact, null, 2) + "\n");

  console.log(JSON.stringify(artifact, null, 2));
  console.log(`artifact: ${artifactPath}`);
} finally {
  globalThis.fetch = realFetch;
}
