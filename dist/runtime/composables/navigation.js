import { hash } from "ohash";
import { encodeQueryParams } from "../utils/query.js";
import { jsonStringify } from "../utils/json.js";
import { addPrerenderPath, shouldUseClientDB, withContentBase } from "./utils.js";
import { queryContent } from "./query.js";
import { useContentPreview } from "./preview.js";
import { useRuntimeConfig } from "#imports";
export const fetchContentNavigation = async (queryBuilder) => {
  const { content } = useRuntimeConfig().public;
  if (typeof queryBuilder?.params !== "function") {
    queryBuilder = queryContent(queryBuilder);
  }
  const params = queryBuilder.params();
  const apiPath = content.experimental.stripQueryParameters ? withContentBase(`/navigation/${process.dev ? "_" : `${hash(params)}.${content.integrity}`}/${encodeQueryParams(params)}.json`) : withContentBase(process.dev ? `/navigation/${hash(params)}` : `/navigation/${hash(params)}.${content.integrity}.json`);
  if (!process.dev && process.server) {
    addPrerenderPath(apiPath);
  }
  if (shouldUseClientDB()) {
    const generateNavigation = await import("./client-db.js").then((m) => m.generateNavigation);
    return generateNavigation(params);
  }
  const data = await $fetch(apiPath, {
    method: "GET",
    responseType: "json",
    params: content.experimental.stripQueryParameters ? void 0 : {
      _params: jsonStringify(params),
      previewToken: useContentPreview().getPreviewToken()
    }
  });
  if (typeof data === "string" && data.startsWith("<!DOCTYPE html>")) {
    throw new Error("Not found");
  }
  return data;
};
