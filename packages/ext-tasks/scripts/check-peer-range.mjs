import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryDirectory = resolve(packageDirectory, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const clientSpecifier = process.argv[2];

assert.match(
  clientSpecifier ?? "",
  /^(?:2|2\.2\.0)$/u,
  "Pass exactly 2.2.0 or 2: 2 resolves the latest stable 2.x release.",
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function main() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ext-tasks-peer-"));
  try {
    const packDirectory = join(temporaryDirectory, "pack");
    const consumerDirectory = join(temporaryDirectory, "consumer");
    await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);

    const [{ filename }] = JSON.parse(
      run(npm, [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ]),
    );
    const tarball = join(packDirectory, filename);
    await writeFile(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    run(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        `@modelcontextprotocol/client@${clientSpecifier}`,
        tarball,
      ],
      { cwd: consumerDirectory },
    );

    const installedClientManifest = JSON.parse(
      await readFile(
        join(
          consumerDirectory,
          "node_modules",
          "@modelcontextprotocol",
          "client",
          "package.json",
        ),
        "utf8",
      ),
    );
    assert.match(
      installedClientManifest.version,
      /^2\./u,
      `Expected @modelcontextprotocol/client 2.x, received ${installedClientManifest.version}`,
    );

    // The consumer exercises the SDK-backed entry points, because a peer
    // matrix that only touches withTasks (custom port, no SDK dependency)
    // could pass while the adapters rely on Client APIs the peer lacks.
    await writeFile(
      join(consumerDirectory, "adapter.ts"),
      `import {
  createSessionPortFromClient,
  createTaskSessionFromClient,
  withTasks,
} from "@modelcontextprotocol/ext-tasks/client";
import type { ConnectedMcpSessionPort } from "@modelcontextprotocol/ext-tasks/client";
import { bindTaskReceiver } from "@modelcontextprotocol/ext-tasks/receiver";
import { Client } from "@modelcontextprotocol/client";

declare const port: ConnectedMcpSessionPort;
const session = withTasks(port);
void session;
const client = new Client({ name: "peer-check", version: "0.0.0" });
const sdkPort = createSessionPortFromClient(client, "peer-check");
void sdkPort;
const sdkSession = createTaskSessionFromClient(client, {
  endpointId: "peer-check",
});
void sdkSession;
const receiver = bindTaskReceiver(client, {
  methods: { "elicitation/create": true },
  elicitation: async () => ({ action: "cancel" }),
});
void receiver;
`,
    );
    await writeFile(
      join(consumerDirectory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["adapter.ts"],
      }),
    );
    run(
      process.execPath,
      [
        resolve(repositoryDirectory, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.json",
      ],
      { cwd: consumerDirectory },
    );

    // The runtime smoke constructs the SDK-backed adapters over the installed
    // peer Client, so an API the peer dropped fails here instead of at a
    // consumer's runtime.
    await writeFile(
      join(consumerDirectory, "runtime.mjs"),
      `import {
  createSessionPortFromClient,
  createTaskSessionFromClient,
} from "@modelcontextprotocol/ext-tasks/client";
import { bindTaskReceiver } from "@modelcontextprotocol/ext-tasks/receiver";
import { Client } from "@modelcontextprotocol/client";

const port = createSessionPortFromClient(
  new Client({ name: "peer-check", version: "0.0.0" }),
  "peer-port",
);
port[Symbol.dispose]();
const session = createTaskSessionFromClient(
  new Client({ name: "peer-check", version: "0.0.0" }),
  { endpointId: "peer-session" },
);
await session.close();
const receiver = bindTaskReceiver(
  // The receiver installs an elicitation handler, and the peer Client
  // rejects handlers for capabilities the client did not declare.
  new Client(
    { name: "peer-check", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  ),
  {
    methods: { "elicitation/create": true },
    elicitation: async () => ({ action: "cancel" }),
  },
);
receiver.close();
`,
    );
    run(process.execPath, ["runtime.mjs"], { cwd: consumerDirectory });

    console.log(
      `Validated packed @modelcontextprotocol/ext-tasks against @modelcontextprotocol/client ${installedClientManifest.version}`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
