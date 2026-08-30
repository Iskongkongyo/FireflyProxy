const postcss = require("postcss");
const valueParser = require("postcss-value-parser");
const { resolveTargetUrl, toProxyUrl } = require("../core/urlMapper");

function rewriteCssUrlValue(value, baseUrl) {
    if (typeof value !== "string" || value.includes("\\")) return value;
    const resolved = resolveTargetUrl(value, baseUrl);
    return resolved ? toProxyUrl(resolved) : value;
}

function rewriteCssValue(value, baseUrl) {
    const parsed = valueParser(String(value || ""));
    parsed.walk(node => {
        if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
        const significantNodes = node.nodes.filter(child => child.type !== "space" && child.type !== "comment");
        if (significantNodes.length !== 1 || !["word", "string"].includes(significantNodes[0].type)) return;

        const targetNode = significantNodes[0];
        const rewritten = rewriteCssUrlValue(targetNode.value, baseUrl);
        if (rewritten === targetNode.value) return;
        node.nodes = [{
            type: "string",
            quote: targetNode.type === "string" ? targetNode.quote : "\"",
            value: rewritten
        }];
    });
    return parsed.toString();
}

function rewriteImportParams(value, baseUrl) {
    const parsed = valueParser(rewriteCssValue(value, baseUrl));
    const targetNode = parsed.nodes.find(node => node.type !== "space" && node.type !== "comment");
    if (!targetNode || targetNode.type !== "string") return parsed.toString();

    const rewritten = rewriteCssUrlValue(targetNode.value, baseUrl);
    if (rewritten !== targetNode.value) targetNode.value = rewritten;
    return parsed.toString();
}

function rewriteCss({ css, stylesheetUrl }) {
    const root = postcss.parse(String(css || ""), { from: undefined });
    root.walkDecls(declaration => {
        declaration.value = rewriteCssValue(declaration.value, stylesheetUrl);
    });
    root.walkAtRules(atRule => {
        if (atRule.name.toLowerCase() === "import") {
            atRule.params = rewriteImportParams(atRule.params, stylesheetUrl);
        }
    });
    return root.toString();
}

module.exports = {
    rewriteCss,
    rewriteCssUrlValue,
    rewriteCssValue,
    rewriteImportParams
};
