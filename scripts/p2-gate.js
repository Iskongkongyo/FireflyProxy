const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const backendDirectory = path.join(repositoryRoot, "backend", "nodejs");
const p1GatePath = path.join(__dirname, "p1-gate.js");
const installDependencies = process.argv.includes("--install");

function npmInvocation(args) {
    if (process.platform !== "win32") return { command: "npm", args };
    return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    };
}

const p1Args = [p1GatePath, ...(installDependencies ? ["--install"] : [])];
const runtimeInvocation = npmInvocation(["run", "test:runtime:e2e"]);
const isolationInvocation = npmInvocation(["run", "test:isolation:e2e"]);
const steps = [
    {
        label: "P1 regression gate",
        command: process.execPath,
        args: p1Args,
        cwd: repositoryRoot
    },
    {
        label: "Runtime Bridge Playwright E2E",
        command: runtimeInvocation.command,
        args: runtimeInvocation.args,
        cwd: backendDirectory
    },
    {
        label: "Origin Isolation Playwright E2E",
        command: isolationInvocation.command,
        args: isolationInvocation.args,
        cwd: backendDirectory
    }
];

for (const [index, step] of steps.entries()) {
    process.stdout.write(`\n[P2 gate ${index + 1}/${steps.length}] ${step.label}\n`);
    const result = spawnSync(step.command, step.args, {
        cwd: step.cwd,
        env: { ...process.env, CI: "true" },
        stdio: "inherit"
    });
    if (result.error) {
        process.stderr.write(`[P2 gate] Unable to run ${step.label}: ${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.stderr.write(`[P2 gate] Failed: ${step.label} (exit ${result.status})\n`);
        process.exit(result.status || 1);
    }
}

process.stdout.write(`\n[P2 gate] PASS (${steps.length}/${steps.length} checks)\n`);
