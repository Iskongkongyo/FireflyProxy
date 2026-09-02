const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    applyScopedResponseTransform,
    hasMatchingResponseTransform,
    isTransformableTextMediaType,
    replaceLiteral,
    responseTransformVersion
} = require("../../browser-proxy/scopedResponseTransform");

function transformConfig(rules) {
    return {
        browser: {
            responseTransform: {
                enabled: true,
                rules
            }
        }
    };
}

function rule(overrides = {}) {
    return {
        id: "main-page",
        enabled: true,
        hosts: ["example.test", "*.assets.test"],
        pathPrefix: "/app/",
        contentTypes: ["text/html", "text/*"],
        replacements: [],
        appendHead: "",
        prependBody: "",
        ...overrides
    };
}

test("scoped response rules require every host, path and content-type boundary", () => {
    const config = transformConfig([rule({
        replacements: [{
            search: "source",
            replacement: "target",
            mode: "all",
            maxReplacements: 10
        }]
    })]);

    assert.equal(hasMatchingResponseTransform(config, "https://example.test/app/index", "text/html"), true);
    assert.equal(hasMatchingResponseTransform(config, "https://cdn.assets.test/app/site.css", "text/css"), true);
    assert.equal(hasMatchingResponseTransform(config, "https://assets.test/app/index", "text/html"), false);
    assert.equal(hasMatchingResponseTransform(config, "https://example.test/other", "text/html"), false);
    assert.equal(hasMatchingResponseTransform(config, "https://example.test/app/index", "application/json"), false);
    assert.equal(hasMatchingResponseTransform(config, "not-a-url", "text/html"), false);
});

test("HTML-only injections do not buffer matching non-HTML text", () => {
    const config = transformConfig([rule({
        contentTypes: ["application/json"],
        appendHead: "<meta name=proxyweb>"
    })]);

    assert.equal(hasMatchingResponseTransform(
        config,
        "https://example.test/app/data.json",
        "application/json"
    ), false);
});

test("only textual media types can enter scoped response transforms", () => {
    for (const mediaType of ["text/html", "text/css", "application/json", "application/problem+json", "image/svg+xml"]) {
        assert.equal(isTransformableTextMediaType(mediaType), true, mediaType);
    }
    for (const mediaType of ["text/event-stream", "image/png", "video/mp4", "application/octet-stream", ""]) {
        assert.equal(isTransformableTextMediaType(mediaType), false, mediaType);
    }
});

test("literal replacement treats metacharacters as text and obeys its exact limit", () => {
    assert.deepEqual(replaceLiteral("a.$ a.$ a.$", "a.$", "$value", 2), {
        text: "$value $value a.$",
        replacements: 2
    });
    assert.deepEqual(replaceLiteral("unchanged", "missing", "value", 10), {
        text: "unchanged",
        replacements: 0
    });
});

test("matching rules apply replacements in order and inject HTML structurally", () => {
    const config = transformConfig([
        rule({
            replacements: [{
                search: "ORIGINAL",
                replacement: "FIRST",
                mode: "once",
                maxReplacements: 10
            }],
            appendHead: "<meta name=first content=yes>",
            prependBody: "<div id=first>FIRST</div>"
        }),
        rule({
            id: "second",
            replacements: [{
                search: "FIRST",
                replacement: "FINAL",
                mode: "all",
                maxReplacements: 2
            }],
            appendHead: "<meta name=second content=yes>",
            prependBody: "<div id=second>second</div>"
        })
    ]);
    const result = applyScopedResponseTransform({
        text: "<!doctype html><html><head><title>ORIGINAL ORIGINAL</title></head><body>ORIGINAL</body></html>",
        mediaType: "text/html",
        targetUrl: "https://example.test/app/index",
        config
    });

    assert.deepEqual(result.matchedRuleIds, ["main-page", "second"]);
    assert.equal(result.replacements, 2);
    assert.match(result.text, /<title>FINAL ORIGINAL<\/title>/);
    assert.ok(result.text.indexOf("name=\"first\"") < result.text.indexOf("name=\"second\""));
    assert.ok(result.text.indexOf("id=\"first\"") < result.text.indexOf("id=\"second\""));
    assert.match(result.text, /<body><div id="first">FIRST<\/div><div id="second">second<\/div>ORIGINAL<\/body>/);
});

test("HTML injection handles fragments and XHTML without inventing unsafe text transforms", () => {
    const htmlConfig = transformConfig([rule({
        appendHead: "<meta name=fragment content=yes>",
        prependBody: "<aside id=fragment>ready</aside>"
    })]);
    const html = applyScopedResponseTransform({
        text: "<main>fragment</main>",
        mediaType: "text/html",
        targetUrl: "https://example.test/app/fragment",
        config: htmlConfig
    });
    assert.match(html.text, /<head><meta name="fragment" content="yes"><\/head>/);
    assert.match(html.text, /<body><aside id="fragment">ready<\/aside><main>fragment<\/main><\/body>/);

    const xhtmlConfig = transformConfig([rule({
        contentTypes: ["application/xhtml+xml"],
        appendHead: "<meta name=xml content=yes />",
        prependBody: "<aside id=xml>ready</aside>"
    })]);
    const xhtml = applyScopedResponseTransform({
        text: '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><main>xml</main></body></html>',
        mediaType: "application/xhtml+xml",
        targetUrl: "https://example.test/app/page.xhtml",
        config: xhtmlConfig
    });
    assert.match(xhtml.text, /<head><meta name="xml" content="yes"\/><\/head>/);
    assert.match(xhtml.text, /<body><aside id="xml">ready<\/aside><main>xml<\/main><\/body>/);
});

test("response transform version is stable and changes with rules", () => {
    const first = transformConfig([rule({ appendHead: "<meta name=one>" })]);
    const same = structuredClone(first);
    const changed = transformConfig([rule({ appendHead: "<meta name=two>" })]);

    assert.equal(responseTransformVersion(first), responseTransformVersion(same));
    assert.notEqual(responseTransformVersion(first), responseTransformVersion(changed));
    assert.match(responseTransformVersion(first), /^[a-f0-9]{16}$/);
});

test("replacement expansion fails before exceeding the shared rewrite output limit", () => {
    const config = transformConfig([rule({
        replacements: [{
            search: "x",
            replacement: "0123456789",
            mode: "all",
            maxReplacements: 10
        }]
    })]);
    config.security = { maxRewriteBytes: 16 };

    assert.throws(
        () => applyScopedResponseTransform({
            text: "xxx",
            mediaType: "text/html",
            targetUrl: "https://example.test/app/index",
            config
        }),
        error => error.code === "PROXY_REWRITE_LIMIT" && error.statusCode === 413
    );
});
