const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const backendDirectory = path.join(repositoryRoot, "backend", "nodejs");
const p0GatePath = path.join(__dirname, "p0-gate.js");
const installDependencies = process.argv.includes("--install");

function npmInvocation(args) {
    if (process.platform !== "win32") return { command: "npm", args };
    return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    };
}

const p0Args = [p0GatePath, ...(installDependencies ? ["--install"] : [])];
const e2eInvocation = npmInvocation(["run", "test:e2e"]);
const steps = [
    {
        label: "P0 regression gate",
        command: process.execPath,
        args: p0Args,
        cwd: repositoryRoot
    },
    {
        label: "Browser Core Playwright E2E",
        command: e2eInvocation.command,
        args: e2eInvocation.args,
        cwd: backendDirectory
    }
];

for (const [index, step] of steps.entries()) {
    process.stdout.write(`\n[P1 gate ${index + 1}/${steps.length}] ${step.label}\n`);
    const result = spawnSync(step.command, step.args, {
        cwd: step.cwd,
        env: { ...process.env, CI: "true" },
        stdio: "inherit"
    });
    if (result.error) {
        process.stderr.write(`[P1 gate] Unable to run ${step.label}: ${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.stderr.write(`[P1 gate] Failed: ${step.label} (exit ${result.status})\n`);
        process.exit(result.status || 1);
    }
}

process.stdout.write(`\n[P1 gate] PASS (${steps.length}/${steps.length} checks)\n`);
