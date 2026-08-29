const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const backendDirectory = path.join(repositoryRoot, "backend", "nodejs");
const frontendDirectory = path.join(repositoryRoot, "vue-request-app");
const installDependencies = process.argv.includes("--install");

function npmInvocation(args) {
    if (process.platform !== "win32") return { command: "npm", args };
    return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    };
}

const steps = [
    ...(installDependencies ? [
        { label: "backend reproducible install", cwd: backendDirectory, args: ["ci"] },
        { label: "frontend reproducible install", cwd: frontendDirectory, args: ["ci"] }
    ] : []),
    { label: "backend unit and integration tests", cwd: backendDirectory, args: ["test"] },
    { label: "backend syntax gate", cwd: backendDirectory, args: ["run", "lint"] },
    { label: "frontend credential regression tests", cwd: frontendDirectory, args: ["test"] },
    { label: "frontend lint", cwd: frontendDirectory, args: ["run", "lint"] },
    { label: "frontend production build", cwd: frontendDirectory, args: ["run", "build"] }
];

for (const [index, step] of steps.entries()) {
    const number = `${index + 1}/${steps.length}`;
    process.stdout.write(`\n[P0 gate ${number}] ${step.label}\n`);
    const invocation = npmInvocation(step.args);
    const result = spawnSync(invocation.command, invocation.args, {
        cwd: step.cwd,
        env: { ...process.env, CI: "true" },
        stdio: "inherit"
    });

    if (result.error) {
        process.stderr.write(`[P0 gate] Unable to run ${step.label}: ${result.error.message}\n`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.stderr.write(`[P0 gate] Failed: ${step.label} (exit ${result.status})\n`);
        process.exit(result.status || 1);
    }
}

process.stdout.write(`\n[P0 gate] PASS (${steps.length}/${steps.length} checks)\n`);
