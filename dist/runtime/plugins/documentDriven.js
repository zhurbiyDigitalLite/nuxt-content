import { withoutTrailingSlash, hasProtocol } from "ufo";
import { pascalCase } from "scule";
import { callWithNuxt } from "#app/nuxt";
import { useContentState } from "../composables/content.js";
import { useContentHelpers } from "../composables/helpers.js";
import { fetchContentNavigation } from "../composables/navigation.js";
import { queryContent } from "../composables/query.js";
import { useRuntimeConfig, addRouteMiddleware, navigateTo, useRoute, defineNuxtPlugin, prefetchComponents, useRouter } from "#imports";
import { componentNames } from "#components";
import layouts from "#build/layouts";
export default defineNuxtPlugin((nuxt) => {
  const moduleOptions = useRuntimeConfig()?.public?.content.documentDriven;
  const isClientDBEnabled = useRuntimeConfig()?.public?.content.experimental.clientDB;
  const { navigation, pages, globals, surrounds } = useContentState();
  const findLayout = (to, page, navigation2, globals2) => {
    if (page && page?.layout) {
      return page.layout;
    }
    if (to.matched.length && to.matched[0].meta?.layout) {
      return to.matched[0].meta.layout;
    }
    if (navigation2 && page) {
      const { navKeyFromPath } = useContentHelpers();
      const layoutFromNav = navKeyFromPath(page._path, "layout", navigation2);
      if (layoutFromNav) {
        return layoutFromNav;
      }
    }
    if (moduleOptions.layoutFallbacks && globals2) {
      let layoutFallback;
      for (const fallback of moduleOptions.layoutFallbacks) {
        if (globals2[fallback] && globals2[fallback].layout) {
          layoutFallback = globals2[fallback].layout;
          break;
        }
      }
      if (layoutFallback) {
        return layoutFallback;
      }
    }
    return "default";
  };
  const refresh = async (to, dedup = false) => {
    nuxt.callHook("content:document-driven:start", { route: to, dedup });
    const routeConfig = to.meta.documentDriven || {};
    if (to.meta.documentDriven === false) {
      return;
    }
    const _path = withoutTrailingSlash(to.path);
    const promises = [];
    if (moduleOptions.navigation && routeConfig.navigation !== false) {
      const navigationQuery = () => {
        const { navigation: navigation2 } = useContentState();
        if (navigation2.value && !dedup) {
          return navigation2.value;
        }
        return fetchContentNavigation().then((_navigation) => {
          navigation2.value = _navigation;
          return _navigation;
        }).catch(() => null);
      };
      promises.push(navigationQuery);
    } else {
      promises.push(() => Promise.resolve(null));
    }
    if (moduleOptions.globals) {
      const globalsQuery = () => {
        const { globals: globals2 } = useContentState();
        if (typeof moduleOptions.globals === "object" && Array.isArray(moduleOptions.globals)) {
          console.log("Globals must be a list of keys with QueryBuilderParams as a value.");
          return;
        }
        return Promise.all(
          Object.entries(moduleOptions.globals).map(
            ([key, query]) => {
              if (!dedup && globals2.value[key]) {
                return globals2.value[key];
              }
              let type = "findOne";
              if (query?.type) {
                type = query.type;
              }
              return queryContent(query)[type]().catch(() => null);
            }
          )
        ).then(
          (values) => {
            return values.reduce(
              (acc, value, index) => {
                const key = Object.keys(moduleOptions.globals)[index];
                acc[key] = value;
                return acc;
              },
              {}
            );
          }
        );
      };
      promises.push(globalsQuery);
    } else {
      promises.push(() => Promise.resolve(null));
    }
    if (moduleOptions.page && routeConfig.page !== false) {
      let where = { _path };
      if (typeof routeConfig.page === "string") {
        where = { _path: routeConfig.page };
      }
      if (typeof routeConfig.page === "object") {
        where = routeConfig.page;
      }
      const pageQuery = () => {
        const { pages: pages2 } = useContentState();
        if (!dedup && pages2.value[_path] && pages2.value[_path]._path === _path) {
          return {
            result: pages2.value[_path],
            surround: surrounds.value[_path]
          };
        }
        const query = queryContent().where(where).withDirConfig();
        if (moduleOptions.surround && routeConfig.surround !== false) {
          let surround = _path;
          if (["string", "object"].includes(typeof routeConfig.page)) {
            surround = routeConfig.page;
          }
          if (["string", "object"].includes(typeof routeConfig.surround)) {
            surround = routeConfig.surround;
          }
          query.withSurround(surround);
        }
        return query.findOne().catch(() => null);
      };
      promises.push(pageQuery);
    } else {
      promises.push(() => Promise.resolve(null));
    }
    return await Promise.all(promises.map((promise) => promise())).then(async ([
      _navigation,
      _globals,
      _page
    ]) => {
      if (_navigation) {
        navigation.value = _navigation;
      }
      if (_globals) {
        globals.value = _globals;
      }
      if (_page?.surround) {
        surrounds.value[_path] = _page.surround;
      }
      const redirectTo = _page?.result?.redirect || _page?.dirConfig?.navigation?.redirect;
      if (redirectTo) {
        pages.value[_path] = _page.result;
        return redirectTo;
      }
      if (_page?.result) {
        const layoutName = findLayout(to, _page.result, _navigation, _globals);
        const layout = layouts[layoutName];
        if (layout && typeof layout === "function") {
          await layout();
        }
        to.meta.layout = layoutName;
        _page.result.layout = layoutName;
      }
      pages.value[_path] = _page?.result;
      await nuxt.callHook("content:document-driven:finish", { route: to, dedup, page: _page?.result, navigation: _navigation, globals: _globals, surround: _page?.surround });
    });
  };
  if (process.client) {
    const router = useRouter();
    nuxt.hook("link:prefetch", (link) => {
      if (!(link in pages.value) && !hasProtocol(link)) {
        const route = router.resolve(link);
        if (route.matched.length > 0) {
          refresh(route);
        }
      }
    });
    nuxt.hooks.hook("content:document-driven:finish", ({ page }) => {
      if (page?.body?.children) {
        prefetchBodyComponents(page.body.children);
      }
    });
  }
  addRouteMiddleware(async (to, from) => {
    if (process.client && !isClientDBEnabled && to.path === from.path) {
      if (!to.meta.layout) {
        const _path = withoutTrailingSlash(to.path);
        if (pages.value[_path]) {
          to.meta.layout = pages.value[_path].layout;
        }
      }
      return;
    }
    const redirect = await refresh(to, false);
    if (redirect) {
      if (hasProtocol(redirect)) {
        return callWithNuxt(nuxt, navigateTo, [redirect, { external: true }]);
      } else {
        return redirect;
      }
    }
  });
  nuxt.hook("app:data:refresh", async () => process.client && await refresh(useRoute(), true));
});
function prefetchBodyComponents(nodes) {
  for (const node of nodes) {
    if (node.children) {
      prefetchBodyComponents(node.children);
    }
    if (node.type === "element" && node.tag) {
      const el = pascalCase(node.tag);
      for (const name of ["Prose" + el, el]) {
        if (componentNames.includes(name)) {
          prefetchComponents(name);
        }
      }
    }
  }
}
