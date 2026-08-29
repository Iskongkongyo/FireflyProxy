function appendWarning(res, warning) {
    const current = res.getHeader("warning");
    if (current === undefined) {
        res.setHeader("Warning", warning);
    } else if (Array.isArray(current)) {
        res.setHeader("Warning", [...current, warning]);
    } else {
        res.setHeader("Warning", [current, warning]);
    }
}

function markDeprecated(res, warning, successor) {
    res.setHeader("Deprecation", "true");
    appendWarning(res, warning);
    if (successor) res.setHeader("Link", `<${successor}>; rel="successor-version"`);
}

module.exports = {
    appendWarning,
    markDeprecated
};
