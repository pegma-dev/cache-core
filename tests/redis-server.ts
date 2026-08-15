import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

/**
 * Runs a real Redis for the adapter suite, so conformance is verified against
 * the protocol rather than a hand-written fake.
 *
 * The port is deliberately not Redis's default, so a developer already
 * running Redis for something else does not collide with this.
 */
export const REDIS_PORT = 16379;
export const REDIS_URL = `redis://127.0.0.1:${String(REDIS_PORT)}`;

let child: ChildProcess | undefined;
let inherited = false;

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (accepting: boolean) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepting(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Redis did not start listening on port ${String(port)} within ${String(timeoutMs)}ms.`,
  );
}

export async function setup(): Promise<void> {
  if (await portAccepting(REDIS_PORT)) {
    inherited = true;
    return;
  }

  child = spawn(
    "redis-server",
    [
      "--port",
      String(REDIS_PORT),
      "--bind",
      "127.0.0.1",
      "--save",
      "",
      "--appendonly",
      "no",
      "--protected-mode",
      "no",
    ],
    { stdio: "ignore" },
  );

  child.once("error", (error) => {
    throw new Error(
      `Could not start redis-server on port ${String(REDIS_PORT)}. Install Redis or set a service on that port.`,
      { cause: error },
    );
  });

  await waitForPort(REDIS_PORT, 30_000);
}

export async function teardown(): Promise<void> {
  if (inherited) {
    return;
  }
  child?.kill();
  child = undefined;
}
