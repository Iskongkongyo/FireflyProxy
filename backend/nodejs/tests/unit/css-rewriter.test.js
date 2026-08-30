const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    rewriteCss,
    rewriteCssUrlValue,
    rewriteCssValue,
    rewriteImportParams
} = require("../../browser-proxy/cssRewriter");
const { toProxyUrl } = require("../../core/urlMapper");

const stylesheetUrl = "https://site.test/styles/components/main.css?version=1";
const mapped = target => toProxyUrl(target);

test("CSS declarations rewrite relative, root-relative and cross-origin url() targets", () => {
    const output = rewriteCss({
        stylesheetUrl,
        css: `
            .hero { background: url(../../images/hero.png); }
            .icon { mask-image: url("/icons/sprite.svg#check"); }
            @font-face { src: url(//cdn.test/fonts/site.woff2) format("woff2"); }
            .embedded { background: url(data:image/png;base64,AAAA); }
            .fragment { filter: url(#local-filter); }
        `
    });

    assert.match(output, new RegExp(mapped("https://site.test/images/hero.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, new RegExp(mapped("https://site.test/icons/sprite.svg#check").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, new RegExp(mapped("https://cdn.test/fonts/site.woff2").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, /url\(data:image\/png;base64,AAAA\)/);
    assert.match(output, /url\(#local-filter\)/);
});

test("CSS @import rewrites quoted and url() targets while preserving conditions", () => {
    assert.equal(
        rewriteImportParams('"theme/base.css" layer(theme) screen', stylesheetUrl),
        `"${mapped("https://site.test/styles/components/theme/base.css")}" layer(theme) screen`
    );
    assert.equal(
        rewriteImportParams("url('../print.css') print", stylesheetUrl),
        `url('${mapped("https://site.test/styles/print.css")}') print`
    );

    const output = rewriteCss({
        stylesheetUrl,
        css: '@import "theme.css" screen; @import url(data:text/css,body{}) print;'
    });
    assert.match(output, new RegExp(mapped("https://site.test/styles/components/theme.css").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, /data:text\/css,body\{\}/);
});

test("CSS value rewriting handles nested functions and conservatively preserves escaped targets", () => {
    const output = rewriteCssValue(
        "image-set(url(small.png) 1x, url('../large.png') 2x)",
        stylesheetUrl
    );

    assert.match(output, new RegExp(mapped("https://site.test/styles/components/small.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, new RegExp(mapped("https://site.test/styles/large.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(rewriteCssUrlValue("escaped\\ name.png", stylesheetUrl), "escaped\\ name.png");
    assert.equal(rewriteCssUrlValue("mailto:test@example.com", stylesheetUrl), "mailto:test@example.com");
});
