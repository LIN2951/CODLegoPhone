#!/usr/bin/env node
'use strict';

/**
 * Build-time merge: inject fragments/*.html into index.html at the same anchors
 * as runtime html-fragments.js (order matters). Produces a single HTML file with
 * no remaining wechat-*-fragment-anchor divs, suitable for static hosting without fetch.
 *
 * Keep FRAGMENT_HOSTS in sync with html-fragments.js FRAGMENT_HOSTS.
 */

const fs = require('fs');
const path = require('path');

const FRAGMENT_HOSTS = [
    { anchorId: 'wechat-page-fragment-anchor', file: 'fragments/wechat-page.html' },
    { anchorId: 'wechat-me-page-fragment-anchor', file: 'fragments/wechat-me-page.html' },
    { anchorId: 'wechat-settings-page-fragment-anchor', file: 'fragments/wechat-settings-page.html' }
];

function anchorRegex(anchorId) {
    var escaped = anchorId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('<div\\s+id="' + escaped + '"\\s*>\\s*</div>');
}

function printHelp() {
    console.log(
        [
            'Usage: node scripts/inline-html-fragments.js [-i index.html] [-o out.html]',
            '',
            '  -i   Input HTML (default: ./index.html)',
            '  -o   Output HTML (default: ./dist/index-inlined.html)',
            '  --check   Verify anchors exist and fragments load; do not write'
        ].join('\n')
    );
}

function main() {
    var root = process.cwd();
    var args = process.argv.slice(2);
    var outPath = path.join(root, 'dist', 'index-inlined.html');
    var inputPath = path.join(root, 'index.html');
    var checkOnly = false;

    for (var i = 0; i < args.length; i++) {
        if (args[i] === '-o' && args[i + 1]) {
            outPath = path.resolve(args[++i]);
            continue;
        }
        if (args[i] === '-i' && args[i + 1]) {
            inputPath = path.resolve(args[++i]);
            continue;
        }
        if (args[i] === '--check') {
            checkOnly = true;
            continue;
        }
        if (args[i] === '-h' || args[i] === '--help') {
            printHelp();
            process.exit(0);
        }
    }

    if (!fs.existsSync(inputPath)) {
        console.error('Input not found:', inputPath);
        process.exit(1);
    }

    var html = fs.readFileSync(inputPath, 'utf8');

    for (var h = 0; h < FRAGMENT_HOSTS.length; h++) {
        var host = FRAGMENT_HOSTS[h];
        var fragmentPath = path.join(root, host.file);
        if (!fs.existsSync(fragmentPath)) {
            console.error('Fragment not found:', fragmentPath);
            process.exit(1);
        }
        var re = anchorRegex(host.anchorId);
        if (!re.test(html)) {
            console.error('Anchor not found in HTML:', host.anchorId);
            process.exit(1);
        }
        html = html.replace(re, function () {
            return fs.readFileSync(fragmentPath, 'utf8');
        });
    }

    if (checkOnly) {
        console.log('OK: all anchors replaced (dry run, no write).');
        process.exit(0);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log('Wrote', outPath);
}

main();
