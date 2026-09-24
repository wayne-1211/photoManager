// js/core/router.js — hash 路由: 只換掉 #page-outlet, 側邊欄與照片來源列一直活著。

import { icon } from "../utils/utils.js";

/**
 * 每個路由就是功能列上的一項。
 *   group   側邊欄的分組標題, 同一組的連在一起。
 *   source  這一頁要不要顯示照片來源列（跨頁共用的狀態, 留在外殼上）。
 *   tool    這一頁是工具頁, 由 pages/tool.js 掛載 js/tools/<id>/index.js。
 */
export const ROUTES = {
  photos: {
    fragment: "pages/photos.html", module: "../pages/photos.js",
    label: "照片檢視", icon: "image", nav: true, group: "照片管理", source: true,
  },
  stats: {
    fragment: "pages/stats.html", module: "../pages/stats.js",
    label: "統計數據", icon: "chart", nav: true, group: "照片管理", source: true,
  },
  organize: {
    fragment: "pages/organize.html", module: "../pages/organize.js",
    label: "整理分類", icon: "layers", nav: true, group: "照片管理", source: true,
  },
  rename: {
    fragment: "pages/rename.html", module: "../pages/rename.js",
    label: "批次改名", icon: "copy", nav: true, group: "照片管理", source: true,
  },
  settings: {
    fragment: "pages/settings.html", module: "../pages/settings.js",
    label: "分類設定", icon: "sliders", nav: true, group: "照片管理",
  },
  edit: {
    fragment: "pages/tool.html", module: "../pages/tool.js", tool: "photo-edit",
    label: "裁切旋轉", icon: "crop", nav: true, group: "照片編輯",
  },
  frame: {
    fragment: "pages/tool.html", module: "../pages/tool.js", tool: "exif-frame",
    label: "EXIF 相框", icon: "frame", nav: true, group: "照片編輯",
  },
  palette: {
    fragment: "pages/tool.html", module: "../pages/tool.js", tool: "palette-card",
    label: "照片色卡", icon: "palette", nav: true, group: "照片編輯",
  },
  "not-found": {
    fragment: "pages/not-found.html", module: "../pages/not-found.js",
    label: "找不到頁面", nav: false,
  },
};

const SITE_TITLE = "Photo Manager";
let cleanup = null;
let started = false;
let renderRevision = 0;

export function routeTo(name, params = {}) {
  location.hash = buildHash(name, params);
}

/** 組出某個路由的 hash, 空參數會被丟掉。 */
export function buildHash(name, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, value);
  }
  const query = search.toString();
  return `#/${name}${query ? `?${query}` : ""}`;
}

/** 只換掉目前路由的 query, 不重新掛載頁面。 */
export function replaceParams(name, params = {}) {
  const hash = buildHash(name, params);
  if (hash === location.hash) return;
  history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

export function readRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return { name: "photos", params: new URLSearchParams() };
  const [name, query = ""] = raw.split("?");
  return {
    name: ROUTES[name] ? name : "not-found",
    params: new URLSearchParams(query),
  };
}

export function renderNavigation(activeName = readRoute().name) {
  const host = document.getElementById("primary-nav");
  if (!host) return;
  host.replaceChildren();
  let lastGroup = null;
  for (const [name, route] of Object.entries(ROUTES)) {
    if (!route.nav) continue;
    if (route.group && route.group !== lastGroup) {
      const head = document.createElement("div");
      head.className = "nav-section";
      head.textContent = route.group;
      host.appendChild(head);
    }
    lastGroup = route.group || null;

    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = `#/${name}`;
    link.title = route.label;
    const isActive = name === activeName;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    const ico = document.createElement("span");
    ico.className = "ico";
    ico.innerHTML = icon(route.icon, { size: "18px" });
    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = route.label;
    link.append(ico, label);
    host.appendChild(link);
  }
}

/** 照片來源列只在需要它的頁面出現, 但狀態一直留著。 */
function syncSourceBar(route) {
  const bar = document.getElementById("sourceBar");
  const warn = document.getElementById("fsWarn");
  if (bar) bar.hidden = !route.source;
  if (warn && warn.dataset.message) warn.hidden = !route.source;
}

export async function renderRoute() {
  const revision = ++renderRevision;
  const routeState = readRoute();
  const route = ROUTES[routeState.name];
  cleanup?.();
  cleanup = null;
  renderNavigation(routeState.name);
  syncSourceBar(route);
  const outlet = document.getElementById("page-outlet");
  outlet.innerHTML = '<div class="state-block" role="status"><div class="spinner" aria-hidden="true"></div>載入頁面…</div>';
  try {
    const [response, controller] = await Promise.all([
      fetch(route.fragment),
      import(route.module),
    ]);
    if (!response.ok) throw new Error(`無法載入 ${route.fragment}`);
    const html = await response.text();
    if (revision !== renderRevision) return;
    outlet.innerHTML = html;
    document.title = `${route.label} · ${SITE_TITLE}`;
    cleanup = await controller.mountPage({
      params: routeState.params,
      route: { name: routeState.name, ...route },
      routeTo,
    }) || null;
  } catch (error) {
    console.error(error);
    outlet.innerHTML = `<div class="banner banner-danger" role="alert">頁面載入失敗: ${error.message}。請重新整理頁面後再試一次。</div>`;
  }
}

export function startRouter() {
  if (!started) {
    window.addEventListener("hashchange", renderRoute);
    started = true;
  }
  // 沒有首頁: 照片檢視就是進來的第一頁。
  if (!location.hash || location.hash === "#/") location.hash = "#/photos";
  else renderRoute();
}
