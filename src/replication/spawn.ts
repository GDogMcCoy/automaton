/**
 * Spawn
 *
 * Spawn child automatons in new Conway sandboxes.
 * The parent creates a new sandbox, installs the runtime,
 * writes a genesis config, funds the child, and starts it.
 */

import fs from "fs";
import pathLib from "path";
import type {
  ConwayClient,
  AutomatonIdentity,
  AutomatonDatabase,
  ChildAutomaton,
  GenesisConfig,
  AutomatonConfig,
} from "../types.js";
import { MAX_CHILDREN } from "../types.js";
import { ulid } from "ulid";
import { fetchWithRetry } from "../utils/retry.js";

/** Maximum time allowed for the entire spawn process (5 minutes). */
const SPAWN_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum time to wait for a child health check after spawn (30 seconds). */
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/** Maximum allowed length for the specialization string in genesis config. */
const MAX_SPECIALIZATION_LENGTH = 500;

/** Maximum allowed length for the genesisPrompt string. */
const MAX_GENESIS_PROMPT_LENGTH = 10_000;

/**
 * Spawn a child automaton in a new Conway sandbox.
 */
export async function spawnChild(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  config?: AutomatonConfig,
): Promise<ChildAutomaton> {
  // Check if replication is enabled
  if (!config?.replicationEnabled) {
    throw new Error("Replication is disabled. Set replicationEnabled: true in config to enable.");
  }

  // Input validation
  validateGenesisConfig(genesis);

  // Check child limit
  const existing = db.getChildren().filter(
    (c) => c.status !== "dead",
  );
  if (existing.length >= MAX_CHILDREN) {
    throw new Error(
      `Cannot spawn: already at max children (${MAX_CHILDREN}). Kill or wait for existing children to die.`,
    );
  }

  // Check lineage depth
  const { getLineageDepth, MAX_LINEAGE_DEPTH } = await import("./lineage.js");
  const currentDepth = getLineageDepth(config);
  if (currentDepth >= MAX_LINEAGE_DEPTH) {
    throw new Error(
      `Cannot spawn: lineage depth ${currentDepth} has reached the maximum of ${MAX_LINEAGE_DEPTH}.`,
    );
  }

  const childId = ulid();

  // 1. Create a new sandbox for the child
  const sandbox = await conway.createSandbox({
    name: `automaton-child-${genesis.name.toLowerCase().replace(/\s+/g, "-")}`,
    vcpu: 1,
    memoryMb: 512,
    diskGb: 5,
  });

  // Wrap remaining spawn steps with rollback-on-failure and an overall timeout
  const spawnPromise = (async () => {
    try {
      const child: ChildAutomaton = {
        id: childId,
        name: genesis.name,
        address: "0x0000000000000000000000000000000000000000" as any, // Will be set after keygen
        sandboxId: sandbox.id,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        fundedAmountCents: 0,
        status: "spawning",
        createdAt: new Date().toISOString(),
      };

      db.insertChild(child);

      // 2. Install Node.js and the automaton runtime in the child sandbox
      await execInSandbox(conway, sandbox.id, "apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120000);

      // 3. Install the automaton runtime
      await execInSandbox(
        conway,
        sandbox.id,
        "npm install -g @conway/automaton@latest 2>/dev/null || true",
        60000,
      );

      // 4. Write the genesis configuration
      const genesisJson = JSON.stringify(
        {
          name: genesis.name,
          genesisPrompt: genesis.genesisPrompt,
          creatorMessage: genesis.creatorMessage,
          creatorAddress: identity.address, // Parent is the creator
          parentAddress: identity.address,
          lineageDepth: currentDepth + 1,
        },
        null,
        2,
      );

      await writeInSandbox(
        conway,
        sandbox.id,
        "/root/.automaton/genesis.json",
        genesisJson,
      );

      // 4b. Propagate constitution (immutable, inherited before anything else)
      const constitutionPath = pathLib.join(
        process.env.HOME || "/root",
        ".automaton",
        "constitution.md",
      );
      try {
        const constitution = fs.readFileSync(constitutionPath, "utf-8");
        await writeInSandbox(
          conway,
          sandbox.id,
          "/root/.automaton/constitution.md",
          constitution,
        );
        // Make it read-only in the child
        await execInSandbox(conway, sandbox.id, "chmod 444 /root/.automaton/constitution.md", 5000);
      } catch {
        // Constitution file not found locally — child will get it from the repo on build
      }

      // 5. Health check: verify the child sandbox is responsive
      await verifyChildHealth(conway, sandbox.id);

      // 6. Record the spawn
      db.insertModification({
        id: ulid(),
        timestamp: new Date().toISOString(),
        type: "child_spawn",
        description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}`,
        reversible: false,
      });

      return child;
    } catch (error) {
      // Rollback: attempt to delete the sandbox to prevent resource leaks
      try {
        await conway.deleteSandbox(sandbox.id);
      } catch {
        // Best-effort cleanup — log but do not mask the original error
        process.stderr.write(
          `[spawn] WARNING: failed to delete sandbox ${sandbox.id} during rollback\n`,
        );
      }

      // Update child status in DB if it was already inserted
      try {
        db.updateChildStatus(childId, "dead");
      } catch {
        // Child may not have been inserted yet — ignore
      }

      throw error;
    }
  })();

  // Apply overall spawn timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Spawn timed out after ${SPAWN_TIMEOUT_MS}ms`)),
      SPAWN_TIMEOUT_MS,
    );
  });

  return Promise.race([spawnPromise, timeoutPromise]);
}

/**
 * Start a child automaton after setup.
 */
export async function startChild(
  conway: ConwayClient,
  db: AutomatonDatabase,
  childId: string,
): Promise<void> {
  const child = db.getChildById(childId);
  if (!child) throw new Error(`Child ${childId} not found`);

  // Initialize wallet, provision, and run
  await execInSandbox(
    conway,
    child.sandboxId,
    "automaton --init && automaton --provision && systemctl start automaton 2>/dev/null || automaton --run &",
    60000,
  );

  db.updateChildStatus(childId, "running");
}

/**
 * Check a child's status.
 */
export async function checkChildStatus(
  conway: ConwayClient,
  db: AutomatonDatabase,
  childId: string,
): Promise<string> {
  const child = db.getChildById(childId);
  if (!child) throw new Error(`Child ${childId} not found`);

  try {
    const result = await execInSandbox(
      conway,
      child.sandboxId,
      "automaton --status 2>/dev/null || echo 'offline'",
      10000,
    );

    const output = result.stdout || "unknown";

    // Parse status from output
    if (output.includes("dead")) {
      db.updateChildStatus(childId, "dead");
    } else if (output.includes("sleeping")) {
      db.updateChildStatus(childId, "sleeping");
    } else if (output.includes("running")) {
      db.updateChildStatus(childId, "running");
    }

    return output;
  } catch {
    db.updateChildStatus(childId, "unknown");
    return "Unable to reach child sandbox";
  }
}

/**
 * Send a message to a child automaton.
 */
export async function messageChild(
  conway: ConwayClient,
  db: AutomatonDatabase,
  childId: string,
  message: string,
): Promise<void> {
  const child = db.getChildById(childId);
  if (!child) throw new Error(`Child ${childId} not found`);

  // Write message to child's message queue
  const msgJson = JSON.stringify({
    from: "parent",
    content: message,
    timestamp: new Date().toISOString(),
  });

  await writeInSandbox(
    conway,
    child.sandboxId,
    `/root/.automaton/inbox/${ulid()}.json`,
    msgJson,
  );
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Validate genesis config fields to prevent oversized or malicious input.
 */
function validateGenesisConfig(genesis: GenesisConfig): void {
  if (!genesis.name || genesis.name.trim().length === 0) {
    throw new Error("Genesis config: name is required.");
  }

  if (genesis.genesisPrompt && genesis.genesisPrompt.length > MAX_GENESIS_PROMPT_LENGTH) {
    throw new Error(
      `Genesis config: genesisPrompt exceeds maximum length of ${MAX_GENESIS_PROMPT_LENGTH} characters (got ${genesis.genesisPrompt.length}).`,
    );
  }

  // Check specialization if embedded in the genesisPrompt (from genesis.ts)
  const specMatch = genesis.genesisPrompt?.match(
    /--- SPECIALIZATION ---\n[\s\S]*?Your specific focus:\n([\s\S]*?)\n--- END SPECIALIZATION ---/,
  );
  if (specMatch && specMatch[1] && specMatch[1].length > MAX_SPECIALIZATION_LENGTH) {
    throw new Error(
      `Genesis config: specialization exceeds maximum length of ${MAX_SPECIALIZATION_LENGTH} characters (got ${specMatch[1].length}).`,
    );
  }
}

/**
 * Verify the child sandbox is alive and responsive after spawn setup.
 * Waits up to HEALTH_CHECK_TIMEOUT_MS for a successful status check.
 */
async function verifyChildHealth(
  conway: ConwayClient,
  sandboxId: string,
): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 3000;

  while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
    try {
      const result = await execInSandbox(
        conway,
        sandboxId,
        "echo 'health-check-ok'",
        10000,
      );
      if (result.stdout?.includes("health-check-ok")) {
        return; // Child is responsive
      }
    } catch {
      // Not ready yet — wait and retry
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Child sandbox ${sandboxId} failed health check within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
  );
}

async function execInSandbox(
  conway: ConwayClient,
  sandboxId: string,
  command: string,
  timeout: number = 30000,
) {
  // Use the Conway API to exec in a specific sandbox
  const apiUrl = (conway as any).__apiUrl || "https://api.conway.tech";
  const apiKey = (conway as any).__apiKey || "";

  const resp = await fetchWithRetry(`${apiUrl}/v1/sandboxes/${sandboxId}/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ command, timeout }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Exec in sandbox ${sandboxId} failed: ${text}`);
  }

  return resp.json();
}

async function writeInSandbox(
  conway: ConwayClient,
  sandboxId: string,
  path: string,
  content: string,
) {
  const apiUrl = (conway as any).__apiUrl || "https://api.conway.tech";
  const apiKey = (conway as any).__apiKey || "";

  // Ensure parent directory exists
  const dir = path.substring(0, path.lastIndexOf("/"));
  await execInSandbox(conway, sandboxId, `mkdir -p ${dir}`, 5000);

  const resp = await fetchWithRetry(
    `${apiUrl}/v1/sandboxes/${sandboxId}/files/upload/json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ path, content }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Write to sandbox ${sandboxId} failed: ${text}`);
  }
}
