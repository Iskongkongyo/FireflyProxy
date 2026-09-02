const assert = require("node:assert/strict");
const { test } = require("node:test");
const cheerio = require("cheerio");
const {
    rewriteHtml,
    rewriteInlineStyle,
    rewriteMetaRefresh,
    rewriteSrcset,
    rewriteUrlValue
} = require("../../browser-proxy/htmlRewriter");
const { toProxyUrl } = require("../../core/urlMapper");

const documentUrl = "https://site.test/docs/page.html?view=full";
const mapped = target => toProxyUrl(target);

test("HTML attributes resolve through the first base URL and ignored schemes remain unchanged", () => {
    const output = rewriteHtml({
        documentUrl,
        html: `<!doctype html><html><head>
            <base href="../assets/">
            <link id="css" href="/site.css">
            <meta http-equiv="Refresh" content="0; URL='../landing'">
            <style id="page-style">@import "page-theme.css"; .banner { background: url('banner.png'); }</style>
            <style id="less-style" type="text/less">.less { background: url('less.png'); }</style>
        </head><body>
            <a id="nav" href="guide.html#intro">Guide</a>
            <area id="area" href="map.html">
            <script id="script" src="//cdn.test/app.js"></script>
            <img id="image" src="image.png" srcset="small.png 1x, /large.png 2x">
            <source id="source" src="clip.mp4" srcset="clip-small.mp4 480w, clip-large.mp4 960w">
            <iframe id="iframe" src="frame.html"></iframe>
            <form id="form" action="?submit=1"></form>
            <input id="input" src="submit.png" formaction="upload">
            <button id="button" formaction="save">Save</button>
            <video id="video" src="movie.mp4" poster="poster.jpg"></video>
            <audio id="audio" src="sound.mp3"></audio>
            <track id="track" src="captions.vtt">
            <object id="object" data="manual.pdf"></object>
            <embed id="embed" src="plugin.bin">
            <div id="styled" style="background:url('../img/bg.png');mask:url(data:image/png;base64,AAAA)"></div>
            <a id="fragment" href="#local">Local</a>
            <a id="mail" href="mailto:test@example.com">Mail</a>
            <a id="script-link" href="javascript:alert(1)">Script</a>
        </body></html>`
    });
    const $ = cheerio.load(output);

    assert.equal($("base").attr("href"), mapped("https://site.test/assets/"));
    assert.equal($("#css").attr("href"), mapped("https://site.test/site.css"));
    assert.equal($("#nav").attr("href"), mapped("https://site.test/assets/guide.html#intro"));
    assert.equal($("#area").attr("href"), mapped("https://site.test/assets/map.html"));
    assert.equal($("#script").attr("src"), mapped("https://cdn.test/app.js"));
    assert.equal($("#image").attr("src"), mapped("https://site.test/assets/image.png"));
    assert.equal($("#source").attr("src"), mapped("https://site.test/assets/clip.mp4"));
    assert.equal($("#iframe").attr("src"), mapped("https://site.test/assets/frame.html"));
    assert.equal($("#form").attr("action"), mapped("https://site.test/assets/?submit=1"));
    assert.equal($("#input").attr("src"), mapped("https://site.test/assets/submit.png"));
    assert.equal($("#input").attr("formaction"), mapped("https://site.test/assets/upload"));
    assert.equal($("#button").attr("formaction"), mapped("https://site.test/assets/save"));
    assert.equal($("#video").attr("src"), mapped("https://site.test/assets/movie.mp4"));
    assert.equal($("#video").attr("poster"), mapped("https://site.test/assets/poster.jpg"));
    assert.equal($("#audio").attr("src"), mapped("https://site.test/assets/sound.mp3"));
    assert.equal($("#track").attr("src"), mapped("https://site.test/assets/captions.vtt"));
    assert.equal($("#object").attr("data"), mapped("https://site.test/assets/manual.pdf"));
    assert.equal($("#embed").attr("src"), mapped("https://site.test/assets/plugin.bin"));
    assert.equal($("meta").attr("content"), `0; URL='${mapped("https://site.test/landing")}'`);
    assert.match($("#page-style").html(), new RegExp(mapped("https://site.test/assets/page-theme.css").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match($("#page-style").html(), new RegExp(mapped("https://site.test/assets/banner.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal($("#less-style").html(), ".less { background: url('less.png'); }");
    assert.match($("#styled").attr("style"), new RegExp(mapped("https://site.test/img/bg.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match($("#styled").attr("style"), /data:image\/png;base64,AAAA/);
    assert.equal($("#fragment").attr("href"), "#local");
    assert.equal($("#mail").attr("href"), "mailto:test@example.com");
    assert.equal($("#script-link").attr("href"), "javascript:alert(1)");

    const frameDocument = cheerio.load(rewriteHtml({
        documentUrl,
        html: "<!doctype html><html><head><base href='../assets/'></head><frameset><frame id='frame' src='legacy.html'></frameset></html>"
    }));
    assert.equal(frameDocument("#frame").attr("src"), mapped("https://site.test/assets/legacy.html"));
});

test("srcset rewrites candidate URLs while preserving descriptors and data URLs", () => {
    assert.equal(
        rewriteSrcset("small.png 1x, ../large.png 2x", "https://site.test/assets/images/"),
        `${mapped("https://site.test/assets/images/small.png")} 1x, ${mapped("https://site.test/assets/large.png")} 2x`
    );
    assert.equal(
        rewriteSrcset("data:image/png;base64,AAAA 1x, wide.png 1000w", "https://site.test/assets/"),
        `data:image/png;base64,AAAA 1x, ${mapped("https://site.test/assets/wide.png")} 1000w`
    );
});

test("inline CSS and Meta Refresh only rewrite supported HTTP targets", () => {
    const baseUrl = "https://site.test/assets/";
    const style = rewriteInlineStyle(
        "background: url(icons/a.svg); cursor: url('data:image/png;base64,AAAA'), auto",
        baseUrl
    );

    assert.match(style, new RegExp(mapped("https://site.test/assets/icons/a.svg").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(style, /data:image\/png;base64,AAAA/);
    assert.equal(
        rewriteMetaRefresh(" 5 ; URL = \"next.html?x=1\" ", baseUrl),
        ` 5 ; URL = \"${mapped("https://site.test/assets/next.html?x=1")}\" `
    );
    assert.equal(rewriteMetaRefresh("not-a-refresh", baseUrl), "not-a-refresh");
    assert.equal(rewriteMetaRefresh("0; url='unterminated", baseUrl), "0; url='unterminated");
    assert.equal(rewriteUrlValue("https://user:pass@site.test/private", baseUrl), "https://user:pass@site.test/private");
});

test("XHTML is parsed and serialized in XML mode", () => {
    const output = rewriteHtml({
        html: "<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><body><img src=\"asset.png\" /></body></html>",
        documentUrl,
        mediaType: "application/xhtml+xml"
    });

    assert.match(output, /<\?xml version="1\.0"\?>/);
    assert.match(output, new RegExp(mapped("https://site.test/docs/asset.png").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Runtime Bridge is injected first exactly once with the upstream document URL", () => {
    const output = rewriteHtml({
        html: "<!doctype html><html><head><script id='upstream'>window.started = true</script></head><body></body></html>",
        documentUrl,
        runtimeBridge: true,
        scriptCookieBridge: true
    });
    const $ = cheerio.load(output);
    const scripts = $("head script");

    assert.equal(scripts.length, 2);
    assert.equal(scripts.first().attr("src"), "/__proxyweb/runtime.js");
    assert.equal(scripts.first().attr("data-fireflyproxy-runtime"), documentUrl);
    assert.equal(scripts.first().attr("data-fireflyproxy-script-cookie-bridge"), "true");
    assert.equal(scripts.last().attr("id"), "upstream");

    const repeated = rewriteHtml({ html: output, documentUrl, runtimeBridge: true });
    assert.equal(cheerio.load(repeated)("script[data-fireflyproxy-runtime]").length, 1);

    const based = cheerio.load(rewriteHtml({
        html: "<!doctype html><html><head><base href='../assets/'></head><body></body></html>",
        documentUrl,
        runtimeBridge: true
    }));
    assert.equal(
        based("script[data-fireflyproxy-runtime]").attr("data-fireflyproxy-base-url"),
        "https://site.test/assets/"
    );
});
