const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const backendDirectory = path.join(repositoryRoot, "backend", "nodejs");
const p2GatePath = path.join(__dirname, "p2-gate.js");
const installDependencies = process.argv.includes("--install");

function npmInvocation(args) {
    if (process.platform !== "win32") return { command: "npm", args };
    return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    };
}

const p2Args = [p2GatePath, ...(installDependencies ? ["--install"] : [])];
const workspaceInvocation = npmInvocation(["run", "test:workspace:e2e"]);
const steps = [
    {
        label: "P2 regression gate",
        command: process.execPath,
        args: p2Args,
        cwd: repositoryRoot
    },
    {
        label: "Environment and Collections Playwright E2E",
        command: workspaceInvocation.command,
        args: workspaceInvocation.args,
        cwd: backendDirectory
    }
];

for (const [index, step] of steps.entries()) {
    process.stdout.write(`\n[P3 gate ${index + 1}/${steps.length}] ${step.label}\n`);
    const result = spawnSync(step.command, step.args, {
        cwd: step.cwd,
        env: { ...process.env, CI: "true" },
        stdio: "inherit"
    });
    if (result.error) {
        process.stderr.write(`[P3 gate] Unable to run ${step.label}: ${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.stderr.write(`[P3 gate] Failed: ${step.label} (exit ${result.status})\n`);
        process.exit(result.status || 1);
    }
}

process.stdout.write(`\n[P3 gate] PASS (${steps.length}/${steps.length} checks)\n`);
