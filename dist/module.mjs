import fs from 'fs';
import { defineNuxtModule, createResolver, extendViteConfig, addImports, addComponentsDir, addTemplate, addPlugin, installModule, addVitePlugin } from '@nuxt/kit';
import { defu } from 'defu';
import { genSafeVariableName, genImport, genDynamicImport } from 'knitwork';
import { listen } from 'listhen';
import { hash } from 'ohash';
import { resolve, join, relative } from 'pathe';
import { withLeadingSlash, joinURL, withTrailingSlash } from 'ufo';
import { createStorage } from 'unstorage';
import fsDriver from 'unstorage/drivers/fs';
import httpDriver from 'unstorage/drivers/http';
import githubDriver from 'unstorage/drivers/github';
import { WebSocketServer } from 'ws';
import { consola } from 'consola';

const name = "@nuxt/content";
const version = "2.12.0";

function makeIgnored(ignores) {
  const rxAll = ["/\\.", "/-", ...ignores.filter((p) => p)].map((p) => new RegExp(p));
  return function isIgnored(key) {
    const path = "/" + key.replace(/:/g, "/");
    return rxAll.some((rx) => rx.test(path));
  };
}

const logger = consola.withTag("@nuxt/content");
const CACHE_VERSION = 2;
const MOUNT_PREFIX = "content:source:";
const PROSE_TAGS = [
  "p",
  "a",
  "blockquote",
  "code-inline",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "ul",
  "ol",
  "li",
  "strong",
  "table",
  "thead",
  "tbody",
  "td",
  "th",
  "tr"
];
const unstorageDrivers = {
  fs: fsDriver,
  http: httpDriver,
  github: githubDriver
};
async function getMountDriver(mount) {
  const dirverName = mount.driver;
  if (unstorageDrivers[dirverName]) {
    return unstorageDrivers[dirverName](mount);
  }
  try {
    return (await import(mount.driver)).default(mount);
  } catch (e) {
    console.error("Couldn't load driver", mount.driver);
  }
}
function useContentMounts(nuxt, storages) {
  const key = (path, prefix = "") => `${MOUNT_PREFIX}${path.replace(/[/:]/g, "_")}${prefix.replace(/\//g, ":")}`;
  const storageKeys = Object.keys(storages);
  if (Array.isArray(storages) || // Detect object representation of array `{ '0': 'source1' }`. Nuxt converts this array to object when using `nuxt.config.ts`
  storageKeys.length > 0 && storageKeys.every((i) => i === String(+i))) {
    storages = Object.values(storages);
    logger.warn("Using array syntax to define sources is deprecated. Consider using object syntax.");
    storages = storages.reduce((mounts, storage) => {
      if (typeof storage === "string") {
        mounts[key(storage)] = {
          name: storage,
          driver: "fs",
          prefix: "",
          base: resolve(nuxt.options.srcDir, storage)
        };
      }
      if (typeof storage === "object") {
        mounts[key(storage.name, storage.prefix)] = storage;
      }
      return mounts;
    }, {});
  } else {
    storages = Object.entries(storages).reduce((mounts, [name, storage]) => {
      mounts[key(storage.name || name, storage.prefix)] = storage;
      return mounts;
    }, {});
  }
  const defaultStorage = key("content");
  if (!storages[defaultStorage]) {
    storages[defaultStorage] = {
      name: defaultStorage,
      driver: "fs",
      base: resolve(nuxt.options.srcDir, "content")
    };
  }
  return storages;
}
function createWebSocket() {
  const wss = new WebSocketServer({ noServer: true });
  const serve = (req, socket = req.socket, head = "") => wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
  const broadcast = (data) => {
    data = JSON.stringify(data);
    for (const client of wss.clients) {
      try {
        client.send(data);
      } catch (err) {
      }
    }
  };
  return {
    serve,
    broadcast,
    close: () => {
      wss.clients.forEach((client) => client.close());
      return new Promise((resolve2) => wss.close(resolve2));
    }
  };
}
function processMarkdownOptions(options) {
  const anchorLinks = typeof options.anchorLinks === "boolean" ? { depth: options.anchorLinks ? 6 : 0, exclude: [] } : { depth: 4, exclude: [1], ...options.anchorLinks };
  return {
    ...options,
    anchorLinks,
    remarkPlugins: resolveMarkdownPlugins(options.remarkPlugins),
    rehypePlugins: resolveMarkdownPlugins(options.rehypePlugins)
  };
}
function resolveMarkdownPlugins(plugins) {
  if (Array.isArray(plugins)) {
    return Object.values(plugins).reduce((plugins2, plugin) => {
      const [name, pluginOptions] = Array.isArray(plugin) ? plugin : [plugin, {}];
      plugins2[name] = pluginOptions;
      return plugins2;
    }, {});
  }
  return plugins || {};
}

const module = defineNuxtModule({
  meta: {
    name,
    version,
    configKey: "content",
    compatibility: {
      nuxt: "^3.0.0-rc.3"
    }
  },
  defaults: {
    // @deprecated
    base: "",
    api: {
      baseURL: "/api/_content"
    },
    watch: {
      ws: {
        port: {
          port: 4e3,
          portRange: [4e3, 4040]
        },
        hostname: "localhost",
        showURL: false
      }
    },
    sources: {},
    ignores: [],
    locales: [],
    defaultLocale: void 0,
    highlight: false,
    markdown: {
      tags: {
        ...Object.fromEntries(PROSE_TAGS.map((t) => [t, `prose-${t}`])),
        code: "ProseCodeInline"
      },
      anchorLinks: {
        depth: 4,
        exclude: [1]
      }
    },
    yaml: {},
    csv: {
      delimeter: ",",
      json: true
    },
    navigation: {
      fields: []
    },
    contentHead: true,
    documentDriven: false,
    respectPathCase: false,
    experimental: {
      clientDB: false,
      cacheContents: true,
      stripQueryParameters: false,
      advanceQuery: false,
      search: void 0
    }
  },
  async setup(options, nuxt) {
    const { resolve, resolvePath } = createResolver(import.meta.url);
    const resolveRuntimeModule = (path) => resolve("./runtime", path);
    options.locales = Array.from(new Set([options.defaultLocale, ...options.locales].filter(Boolean)));
    const buildIntegrity = nuxt.options.dev ? void 0 : Date.now();
    if (options.base) {
      logger.warn("content.base is deprecated. Use content.api.baseURL instead.");
      options.api.baseURL = withLeadingSlash(joinURL("api", options.base));
    }
    const contentContext = {
      transformers: [],
      ...options
    };
    extendViteConfig((config) => {
      config.optimizeDeps = config.optimizeDeps || {};
      config.optimizeDeps.include = config.optimizeDeps.include || [];
      config.optimizeDeps.include.push("slugify");
      config.plugins?.push({
        name: "content-slot",
        enforce: "pre",
        transform(code) {
          if (code.includes("ContentSlot")) {
            code = code.replace(/<ContentSlot(\s)+([^/>]*)(:use=['"](\$slots.)?([a-zA-Z0-9_-]*)['"])/g, '<MDCSlot$1$2name="$5"');
            code = code.replace(/<\/ContentSlot>/g, "</MDCSlot>");
            code = code.replace(/<ContentSlot/g, "<MDCSlot");
            code = code.replace(/(['"])ContentSlot['"]/g, "$1MDCSlot$1");
            code = code.replace(/ContentSlot\(([^(]*)(:use=['"](\$slots.)?([a-zA-Z0-9_-]*)['"]|use=['"]([a-zA-Z0-9_-]*)['"])([^)]*)/g, 'MDCSlot($1name="$4"$6');
            return {
              code,
              map: { mappings: "" }
            };
          }
        }
      });
    });
    nuxt.hook("nitro:config", (nitroConfig) => {
      nitroConfig.prerender = nitroConfig.prerender || {};
      nitroConfig.prerender.routes = nitroConfig.prerender.routes || [];
      nitroConfig.handlers = nitroConfig.handlers || [];
      nitroConfig.handlers.push(
        {
          method: "get",
          route: `${options.api.baseURL}/query/:qid/**:params`,
          handler: resolveRuntimeModule("./server/api/query")
        },
        {
          method: "get",
          route: `${options.api.baseURL}/query/:qid`,
          handler: resolveRuntimeModule("./server/api/query")
        },
        {
          method: "get",
          route: `${options.api.baseURL}/query`,
          handler: resolveRuntimeModule("./server/api/query")
        },
        {
          method: "get",
          route: nuxt.options.dev ? `${options.api.baseURL}/cache.json` : `${options.api.baseURL}/cache.${buildIntegrity}.json`,
          handler: resolveRuntimeModule("./server/api/cache")
        }
      );
      if (options.experimental?.search) {
        const route = nuxt.options.dev ? `${options.api.baseURL}/search` : `${options.api.baseURL}/search-${buildIntegrity}`;
        nitroConfig.handlers.push({
          method: "get",
          route,
          handler: resolveRuntimeModule("./server/api/search")
        });
        nitroConfig.routeRules = nitroConfig.routeRules || {};
        nitroConfig.routeRules[route] = {
          prerender: true,
          // Use text/plain to avoid Nitro render an index.html
          headers: options.experimental.search.indexed ? { "Content-Type": "text/plain" } : { "Content-Type": "application/json" }
        };
      }
      if (!nuxt.options.dev) {
        nitroConfig.prerender.routes.unshift(`${options.api.baseURL}/cache.${buildIntegrity}.json`);
      }
      const sources = useContentMounts(nuxt, contentContext.sources);
      nitroConfig.devStorage = Object.assign(nitroConfig.devStorage || {}, sources);
      nitroConfig.devStorage["cache:content"] = {
        driver: "fs",
        base: resolve(nuxt.options.buildDir, "content-cache")
      };
      for (const source of Object.values(sources)) {
        if (source.driver === "fs" && source.base.includes(nuxt.options.srcDir)) {
          const wildcard = join(source.base, "**/*").replace(withTrailingSlash(nuxt.options.srcDir), "");
          nuxt.options.ignore.push(
            // Remove `srcDir` from the path
            wildcard,
            `!${wildcard}.vue`
          );
        }
      }
      nitroConfig.bundledStorage = nitroConfig.bundledStorage || [];
      nitroConfig.bundledStorage.push("/cache/content");
      nitroConfig.externals = defu(typeof nitroConfig.externals === "object" ? nitroConfig.externals : {}, {
        inline: [
          // Inline module runtime in Nitro bundle
          resolve("./runtime")
        ]
      });
      nitroConfig.alias = nitroConfig.alias || {};
      nitroConfig.alias["#content/server"] = resolveRuntimeModule(options.experimental.advanceQuery ? "./server" : "./legacy/server");
      const transformers = contentContext.transformers.map((t) => {
        const name2 = genSafeVariableName(relative(nuxt.options.rootDir, t)).replace(/_(45|46|47)/g, "_") + "_" + hash(t);
        return { name: name2, import: genImport(t, name2) };
      });
      nitroConfig.virtual = nitroConfig.virtual || {};
      nitroConfig.virtual["#content/virtual/transformers"] = [
        ...transformers.map((t) => t.import),
        `export const transformers = [${transformers.map((t) => t.name).join(", ")}]`,
        'export const getParser = (ext) => transformers.find(p => ext.match(new RegExp(p.extensions.join("|"),  "i")) && p.parse)',
        'export const getTransformers = (ext) => transformers.filter(p => ext.match(new RegExp(p.extensions.join("|"),  "i")) && p.transform)',
        "export default () => {}"
      ].join("\n");
    });
    addImports([
      { name: "queryContent", as: "queryContent", from: resolveRuntimeModule(`./${options.experimental.advanceQuery ? "" : "legacy/"}composables/query`) },
      { name: "useContentHelpers", as: "useContentHelpers", from: resolveRuntimeModule("./composables/helpers") },
      { name: "useContentHead", as: "useContentHead", from: resolveRuntimeModule("./composables/head") },
      { name: "useContentPreview", as: "useContentPreview", from: resolveRuntimeModule("./composables/preview") },
      { name: "withContentBase", as: "withContentBase", from: resolveRuntimeModule("./composables/utils") },
      { name: "useUnwrap", as: "useUnwrap", from: resolveRuntimeModule("./composables/useUnwrap") }
    ]);
    if (options.experimental?.search) {
      const defaultSearchOptions = {
        indexed: true,
        ignoredTags: ["style", "code"],
        filterQuery: { _draft: false, _partial: false },
        options: {
          fields: ["title", "content", "titles"],
          storeFields: ["title", "content", "titles"],
          searchOptions: {
            prefix: true,
            fuzzy: 0.2,
            boost: {
              title: 4,
              content: 2,
              titles: 1
            }
          }
        }
      };
      options.experimental.search = {
        ...defaultSearchOptions,
        ...options.experimental.search
      };
      nuxt.options.modules.push("@vueuse/nuxt");
      addImports([
        {
          name: "defineMiniSearchOptions",
          as: "defineMiniSearchOptions",
          from: resolveRuntimeModule("./composables/search")
        },
        {
          name: "searchContent",
          as: "searchContent",
          from: resolveRuntimeModule("./composables/search")
        }
      ]);
    }
    addComponentsDir({
      path: resolve("./runtime/components"),
      pathPrefix: false,
      prefix: "",
      global: true
    });
    const componentsContext = { components: [] };
    nuxt.hook("components:extend", (newComponents) => {
      componentsContext.components = newComponents.filter((c) => {
        if (c.pascalName.startsWith("Prose") || c.pascalName === "NuxtLink") {
          return true;
        }
        if (c.filePath.includes("@nuxt/content/dist") || c.filePath.includes("@nuxtjs/mdc/dist") || c.filePath.includes("nuxt/dist/app") || c.filePath.includes("NuxtWelcome")) {
          return false;
        }
        return true;
      });
    });
    addTemplate({
      filename: "content-components.mjs",
      getContents({ options: options2 }) {
        const components = options2.getComponents().filter((c) => !c.island).flatMap((c) => {
          const exp = c.export === "default" ? "c.default || c" : `c['${c.export}']`;
          const isClient = c.mode === "client";
          const definitions = [];
          definitions.push(`export const ${c.pascalName} = ${genDynamicImport(c.filePath)}.then(c => ${isClient ? `createClientOnly(${exp})` : exp})`);
          return definitions;
        });
        return components.join("\n");
      },
      options: { getComponents: () => componentsContext.components }
    });
    const typesPath = addTemplate({
      filename: "types/content.d.ts",
      getContents: () => [
        "declare module '#content/server' {",
        `  const serverQueryContent: typeof import('${resolve(options.experimental.advanceQuery ? "./runtime/server" : "./runtime/legacy/types")}').serverQueryContent`,
        `  const parseContent: typeof import('${resolve("./runtime/server")}').parseContent`,
        "}"
      ].join("\n")
    }).dst;
    nuxt.hook("prepare:types", (options2) => {
      options2.references.push({ path: typesPath });
    });
    const _layers = [...nuxt.options._layers].reverse();
    for (const layer of _layers) {
      const srcDir = layer.config.srcDir;
      const globalComponents = resolve(srcDir, "components/content");
      const dirStat = await fs.promises.stat(globalComponents).catch(() => null);
      if (dirStat && dirStat.isDirectory()) {
        nuxt.hook("components:dirs", (dirs) => {
          dirs.unshift({
            path: globalComponents,
            global: true,
            pathPrefix: false,
            prefix: ""
          });
        });
      }
    }
    if (options.navigation) {
      addImports({ name: "fetchContentNavigation", as: "fetchContentNavigation", from: resolveRuntimeModule(`./${options.experimental.advanceQuery ? "" : "legacy/"}composables/navigation`) });
      nuxt.hook("nitro:config", (nitroConfig) => {
        nitroConfig.handlers = nitroConfig.handlers || [];
        nitroConfig.handlers.push(
          {
            method: "get",
            route: `${options.api.baseURL}/navigation/:qid/**:params`,
            handler: resolveRuntimeModule("./server/api/navigation")
          },
          {
            method: "get",
            route: `${options.api.baseURL}/navigation/:qid`,
            handler: resolveRuntimeModule("./server/api/navigation")
          },
          {
            method: "get",
            route: `${options.api.baseURL}/navigation`,
            handler: resolveRuntimeModule("./server/api/navigation")
          }
        );
      });
    } else {
      addImports({ name: "navigationDisabled", as: "fetchContentNavigation", from: resolveRuntimeModule("./composables/utils") });
    }
    if (options.documentDriven) {
      const defaultDocumentDrivenConfig = {
        page: true,
        navigation: true,
        surround: true,
        globals: {},
        layoutFallbacks: ["theme"],
        injectPage: true
      };
      if (options.documentDriven === true) {
        options.documentDriven = defaultDocumentDrivenConfig;
      } else {
        options.documentDriven = {
          ...defaultDocumentDrivenConfig,
          ...options.documentDriven
        };
      }
      if (options.navigation) {
        options.navigation.fields.push("layout");
      }
      addImports([
        { name: "useContentState", as: "useContentState", from: resolveRuntimeModule("./composables/content") },
        { name: "useContent", as: "useContent", from: resolveRuntimeModule("./composables/content") }
      ]);
      addPlugin(resolveRuntimeModule(
        options.experimental.advanceQuery ? "./plugins/documentDriven" : "./legacy/plugins/documentDriven"
      ));
      if (options.documentDriven.injectPage) {
        nuxt.options.pages = true;
        nuxt.hook("pages:extend", (pages) => {
          if (!pages.find((page) => page.path === "/:slug(.*)*")) {
            pages.unshift({
              name: "slug",
              path: "/:slug(.*)*",
              file: resolveRuntimeModule("./pages/document-driven.vue"),
              children: []
            });
          }
        });
        nuxt.hook("app:resolve", async (app) => {
          if (app.mainComponent?.includes("@nuxt/ui-templates")) {
            app.mainComponent = resolveRuntimeModule("./app.vue");
          } else {
            const appContent = await fs.promises.readFile(app.mainComponent, { encoding: "utf-8" });
            if (appContent.includes("<NuxtLayout") || appContent.includes("<nuxt-layout")) {
              logger.warn([
                "Using `<NuxtLayout>` inside `app.vue` will cause unwanted layout shifting in your application.",
                "Consider removing `<NuxtLayout>` from `app.vue` and using it in your pages."
              ].join(""));
            }
          }
        });
      }
    } else {
      addImports([
        { name: "useContentDisabled", as: "useContentState", from: resolveRuntimeModule("./composables/utils") },
        { name: "useContentDisabled", as: "useContent", from: resolveRuntimeModule("./composables/utils") }
      ]);
    }
    await nuxt.callHook("content:context", contentContext);
    contentContext.defaultLocale = contentContext.defaultLocale || contentContext.locales[0];
    const cacheIntegrity = hash({
      locales: options.locales,
      options: options.defaultLocale,
      markdown: options.markdown,
      hightlight: options.highlight
    });
    contentContext.markdown = processMarkdownOptions(contentContext.markdown);
    const nuxtMDCOptions = {
      remarkPlugins: contentContext.markdown.remarkPlugins,
      rehypePlugins: contentContext.markdown.rehypePlugins,
      highlight: contentContext.highlight,
      components: {
        prose: true,
        map: contentContext.markdown.tags
      },
      headings: {
        anchorLinks: {
          // Reset defaults
          h2: false,
          h3: false,
          h4: false
        }
      }
    };
    if (contentContext.markdown.anchorLinks) {
      for (let i = 0; i < contentContext.markdown.anchorLinks.depth; i++) {
        nuxtMDCOptions.headings.anchorLinks[`h${i + 1}`] = !contentContext.markdown.anchorLinks.exclude.includes(i + 1);
      }
    }
    await installModule("@nuxtjs/mdc", nuxtMDCOptions);
    nuxt.options.runtimeConfig.public.content = defu(nuxt.options.runtimeConfig.public.content, {
      locales: options.locales,
      defaultLocale: contentContext.defaultLocale,
      integrity: buildIntegrity,
      experimental: {
        stripQueryParameters: options.experimental.stripQueryParameters,
        advanceQuery: options.experimental.advanceQuery === true,
        clientDB: options.experimental.clientDB && nuxt.options.ssr === false
      },
      respectPathCase: options.respectPathCase ?? false,
      api: {
        baseURL: options.api.baseURL
      },
      navigation: contentContext.navigation,
      // Tags will use in markdown renderer for component replacement
      // @deprecated
      tags: contentContext.markdown.tags,
      // @deprecated
      highlight: options.highlight,
      wsUrl: "",
      // Document-driven configuration
      documentDriven: options.documentDriven,
      host: typeof options.documentDriven !== "boolean" ? options.documentDriven?.host ?? "" : "",
      trailingSlash: typeof options.documentDriven !== "boolean" ? options.documentDriven?.trailingSlash ?? false : false,
      search: options.experimental.search,
      contentHead: options.contentHead ?? true,
      // Anchor link generation config
      // @deprecated
      anchorLinks: options.markdown.anchorLinks
    });
    nuxt.options.runtimeConfig.content = defu(nuxt.options.runtimeConfig.content, {
      cacheVersion: CACHE_VERSION,
      cacheIntegrity,
      ...contentContext
    });
    nuxt.hook("tailwindcss:config", async (tailwindConfig) => {
      const contentPath = resolve(nuxt.options.buildDir, "content-cache", "parsed/**/*.{md,yml,yaml,json}");
      tailwindConfig.content = tailwindConfig.content ?? [];
      if (Array.isArray(tailwindConfig.content)) {
        tailwindConfig.content.push(contentPath);
      } else {
        tailwindConfig.content.files = tailwindConfig.content.files ?? [];
        tailwindConfig.content.files.push(contentPath);
      }
      const [tailwindCssPath] = Array.isArray(nuxt.options.tailwindcss?.cssPath) ? nuxt.options.tailwindcss?.cssPath : [nuxt.options.tailwindcss?.cssPath];
      let cssPath = tailwindCssPath ? await resolvePath(tailwindCssPath, { extensions: [".css", ".sass", ".scss", ".less", ".styl"] }) : join(nuxt.options.dir.assets, "css/tailwind.css");
      if (!fs.existsSync(cssPath)) {
        cssPath = await resolvePath("tailwindcss/tailwind.css");
      }
      const contentSources = Object.values(useContentMounts(nuxt, contentContext.sources)).map((mount) => mount.driver === "fs" ? mount.base : void 0).filter(Boolean);
      addVitePlugin({
        enforce: "post",
        name: "nuxt:content:tailwindcss",
        handleHotUpdate(ctx) {
          if (!contentSources.some((cs) => ctx.file.startsWith(cs))) {
            return;
          }
          const extraModules = ctx.server.moduleGraph.getModulesByFile(cssPath) || /* @__PURE__ */ new Set();
          const timestamp = +Date.now();
          for (const mod of extraModules) {
            ctx.server.moduleGraph.invalidateModule(mod, void 0, timestamp);
          }
          setTimeout(() => {
            ctx.server.ws.send({
              type: "update",
              updates: Array.from(extraModules).map((mod) => {
                return {
                  type: mod.type === "js" ? "js-update" : "css-update",
                  path: mod.url,
                  acceptedPath: mod.url,
                  timestamp
                };
              })
            });
          }, 100);
        }
      });
    });
    const isIgnored = makeIgnored(contentContext.ignores);
    if (!nuxt.options.dev) {
      nuxt.hook("build:before", async () => {
        const storage = createStorage();
        const sources = useContentMounts(nuxt, contentContext.sources);
        sources["cache:content"] = {
          driver: "fs",
          base: resolve(nuxt.options.buildDir, "content-cache")
        };
        for (const [key, source] of Object.entries(sources)) {
          storage.mount(key, await getMountDriver(source));
        }
        let keys = await storage.getKeys("content:source");
        const invalidKeyCharacters = `'"?#/`.split("");
        keys = keys.filter((key) => {
          if (key.startsWith("preview:") || isIgnored(key)) {
            return false;
          }
          if (invalidKeyCharacters.some((ik) => key.includes(ik))) {
            return false;
          }
          return true;
        });
        await Promise.all(
          keys.map(async (key) => await storage.setItem(
            `cache:content:parsed:${key.substring(15)}`,
            await storage.getItem(key)
          ))
        );
      });
      return;
    }
    addPlugin(resolveRuntimeModule("./plugins/ws"));
    nuxt.hook("nitro:init", async (nitro) => {
      if (!options.watch || !options.watch.ws) {
        return;
      }
      const ws = createWebSocket();
      const { server, url } = await listen(() => "Nuxt Content", options.watch.ws);
      nitro.hooks.hook("close", async () => {
        await ws.close();
        await server.close();
      });
      server.on("upgrade", ws.serve);
      nitro.options.runtimeConfig.public.content.wsUrl = url.replace("http", "ws");
      await nitro.storage.removeItem("cache:content:content-index.json");
      await nitro.storage.watch(async (event, key) => {
        if (!key.startsWith(MOUNT_PREFIX) || isIgnored(key)) {
          return;
        }
        key = key.substring(MOUNT_PREFIX.length);
        await nitro.storage.removeItem("cache:content:content-index.json");
        ws.broadcast({ event, key });
      });
    });
  }
});

export { module as default };
