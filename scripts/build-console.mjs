import {build} from "esbuild";
await build({entryPoints:["apps/console/src/app.ts"],bundle:true,format:"esm",platform:"browser",target:"es2022",outfile:"apps/console/public/app.js",minify:true});
