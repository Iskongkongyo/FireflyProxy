const os = require("node:os");
const ipaddr = require("ipaddr.js");
const proxyaddr = require("proxy-addr");
const { ERROR_CODES, ProxyError } = require("./errors");

const HARD_PROTECTED_RULES = Object.freeze([
    "127.0.0.0/8",
    "::1/128"
]);

function stripAddressDecorations(value) {
    let address = String(value || "").trim();
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    const zone = address.indexOf("%");
    if (zone > -1) address = address.slice(0, zone);
    return address;
}

function normalizeClientIp(value) {
    const candidate = stripAddressDecorations(value);
    if (!ipaddr.isValid(candidate)) return null;
    return ipaddr.process(candidate).toString();
}

function parseClientRule(value) {
    if (typeof value !== "string" || !value || value !== value.trim()) return null;
    if (!value.includes("/")) {
        const address = normalizeClientIp(value);
        if (!address) return null;
        const parsed = ipaddr.parse(address);
        return Object.freeze({
            address,
            family: parsed.kind() === "ipv4" ? 4 : 6,
            prefix: parsed.kind() === "ipv4" ? 32 : 128,
            normalized: address
        });
    }

    let cidr;
    try {
        cidr = ipaddr.parseCIDR(value);
    } catch {
        return null;
    }
    const [sourceAddress, prefix] = cidr;
    const processed = ipaddr.process(sourceAddress.toString());
    if (processed.kind() !== sourceAddress.kind()) return null;
    const bytes = processed.toByteArray();
    let remaining = prefix;
    for (let index = 0; index < bytes.length; index += 1) {
        if (remaining >= 8) {
            remaining -= 8;
        } else if (remaining <= 0) {
            bytes[index] = 0;
        } else {
            bytes[index] &= (0xff << (8 - remaining)) & 0xff;
            remaining = 0;
        }
    }
    const address = ipaddr.fromByteArray(bytes).toString();
    return Object.freeze({
        address,
        family: processed.kind() === "ipv4" ? 4 : 6,
        prefix,
        normalized: `${address}/${prefix}`
    });
}

function normalizeClientRule(value) {
    return parseClientRule(value)?.normalized || null;
}

function clientRuleMatches(ruleValue, addressValue) {
    const rule = typeof ruleValue === "string" ? parseClientRule(ruleValue) : ruleValue;
    const address = normalizeClientIp(addressValue);
    if (!rule || !address) return false;
    const parsed = ipaddr.parse(address);
    if ((parsed.kind() === "ipv4" ? 4 : 6) !== rule.family) return false;
    return parsed.match(ipaddr.parse(rule.address), rule.prefix);
}

function rulesOverlap(leftValue, rightValue) {
    const left = typeof leftValue === "string" ? parseClientRule(leftValue) : leftValue;
    const right = typeof rightValue === "string" ? parseClientRule(rightValue) : rightValue;
    if (!left || !right || left.family !== right.family) return false;
    const prefix = Math.min(left.prefix, right.prefix);
    return ipaddr.parse(left.address).match(ipaddr.parse(right.address), prefix);
}

function localInterfaceAddresses() {
    const addresses = [];
    for (const records of Object.values(os.networkInterfaces())) {
        for (const record of records || []) {
            const address = normalizeClientIp(record.address);
            if (address) addresses.push(address);
        }
    }
    return [...new Set(addresses)];
}

function compileTrust(value) {
    if (value === true) return () => true;
    if (typeof value === "number") return (address, index) => index < value;
    if (!value) return () => false;
    return proxyaddr.compile(value);
}

function resolveUpgradeClientIp(req, trustProxy) {
    try {
        return normalizeClientIp(proxyaddr(req, compileTrust(trustProxy)));
    } catch {
        return normalizeClientIp(req.socket?.remoteAddress);
    }
}

function protectedClientRules(options = {}) {
    const exactAddresses = [
        ...(options.serverAddresses || localInterfaceAddresses()),
        options.localAddress,
        options.currentAdminIp
    ].map(normalizeClientIp).filter(Boolean);
    const configured = Array.isArray(options.neverBlock) ? options.neverBlock : [];
    return [
        ...HARD_PROTECTED_RULES,
        ...exactAddresses,
        ...configured.map(normalizeClientRule).filter(Boolean)
    ];
}

function assertClientRuleCanBeBlocked(ruleValue, options = {}) {
    const rule = parseClientRule(ruleValue);
    if (!rule) {
        throw new ProxyError(ERROR_CODES.ADMIN_CONFIG_INVALID, "Client block rule must be an IP address or CIDR", {
            statusCode: 400
        });
    }
    if (protectedClientRules(options).some(protected => rulesOverlap(rule, protected))) {
        throw new ProxyError(ERROR_CODES.ADMIN_CONFIG_INVALID, "Server, loopback, protected, or current administrator addresses cannot be blocked", {
            statusCode: 400
        });
    }
    return rule.normalized;
}

function createClientBlockMiddleware({ getConfig, auditStore, logger }) {
    const serverAddresses = localInterfaceAddresses();
    return (req, res, next) => {
        const config = getConfig();
        if (!config.clientAccessControl.enabled) return next();
        const address = normalizeClientIp(req.ip || req.socket?.remoteAddress);
        if (!address) return next();
        const protectedRules = protectedClientRules({
            serverAddresses,
            localAddress: req.socket?.localAddress,
            neverBlock: config.clientAccessControl.neverBlock
        });
        if (protectedRules.some(rule => clientRuleMatches(rule, address))) return next();
        let ban;
        try {
            ban = auditStore.findActiveBan(address);
        } catch (error) {
            logger.error("[ClientAccess] Unable to read active bans", { requestId: req.id, error });
            return next(new ProxyError(
                ERROR_CODES.AUDIT_UNAVAILABLE,
                "Client access storage is unavailable",
                { statusCode: 503, cause: error }
            ));
        }
        if (!ban) return next();

        try {
            auditStore.recordBanHit(ban.id);
            auditStore.record({
                category: "security",
                action: "client.blocked",
                outcome: "blocked",
                ip: address,
                method: req.method,
                mode: req.fireflyProxyAdminRoute ? "admin" : "proxy",
                status: 403,
                requestId: req.id,
                detail: `rule=${ban.rule}`
            });
        } catch (error) {
            logger.error("[Audit] Unable to record blocked client", { requestId: req.id, error });
        }
        logger.warn("[ClientAccess] Blocked request", { requestId: req.id, ip: address, rule: ban.rule });
        return next(new ProxyError(ERROR_CODES.CLIENT_BLOCKED, "Client IP is blocked", { statusCode: 403 }));
    };
}

module.exports = {
    HARD_PROTECTED_RULES,
    assertClientRuleCanBeBlocked,
    clientRuleMatches,
    createClientBlockMiddleware,
    localInterfaceAddresses,
    normalizeClientIp,
    normalizeClientRule,
    protectedClientRules,
    resolveUpgradeClientIp,
    rulesOverlap
};
