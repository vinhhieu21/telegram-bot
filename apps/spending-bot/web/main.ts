// The Mini App page: one month of the group's spending, read-only.
// Data comes from GET /api/month (src/web/server.ts); every figure is computed from its rows here,
// so changing the member, day or category filter never waits for the network.
// DOM is built with textContent only: notes and names are user input and never parsed as HTML.

import { CATEGORIES, UNCATEGORIZED_LABEL, type CategoryKey } from "../src/ai/categories";
import { formatVnd } from "../src/report/format";
import type { ApiErrorCode, ApiExpense, MonthResponse } from "../src/web/api";

// --- Telegram ---------------------------------------------------------------------------------

interface TelegramWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  onEvent(event: "themeChanged", handler: () => void): void;
  HapticFeedback?: { selectionChanged(): void };
}
const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;

function applyTheme(): void {
  const scheme = tg?.initData ? tg.colorScheme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = scheme;
}

function haptic(): void {
  tg?.HapticFeedback?.selectionChanged();
}

// --- State ------------------------------------------------------------------------------------

/** "none" stands for uncategorised expenses. */
type CategoryFilter = CategoryKey | "none";

interface State {
  month: string | null; // null: the server's current month
  data: MonthResponse | null;
  error: ApiErrorCode | "network" | null;
  loading: boolean;
  /** null: the whole group. */
  member: number | null;
  day: string | null;
  category: CategoryFilter | null;
  /** How many expense rows the list shows; "Xem thêm" raises it. */
  listLimit: number;
}

const LIST_PAGE = 40;
const state: State = { month: null, data: null, error: null, loading: true, member: null, day: null, category: null, listLimit: LIST_PAGE };
const cache = new Map<string, MonthResponse>();
let requestSeq = 0;

async function load(month: string | null): Promise<void> {
  const seq = ++requestSeq;
  const cached = month ? cache.get(month) : undefined;
  Object.assign(state, { month, error: null, loading: !cached, data: cached ?? state.data, day: null, category: null, listLimit: LIST_PAGE });
  render();
  if (cached) return;

  try {
    const res = await fetch(`/api/month${month ? `?month=${month}` : ""}`, {
      headers: { Authorization: `tma ${tg?.initData ?? ""}` },
    });
    const body = (await res.json()) as MonthResponse | { error: ApiErrorCode };
    if (seq !== requestSeq) return; // a newer month was asked for meanwhile
    if ("error" in body) {
      Object.assign(state, { error: body.error, loading: false });
    } else {
      cache.set(body.month, body);
      Object.assign(state, { month: body.month, data: body, loading: false });
    }
  } catch {
    if (seq !== requestSeq) return;
    Object.assign(state, { error: "network", loading: false });
  }
  render();
}

// --- Derived figures --------------------------------------------------------------------------

function categoryOf(e: { category: string | null }): CategoryFilter {
  return e.category !== null && Object.hasOwn(CATEGORIES, e.category) ? (e.category as CategoryKey) : "none";
}

function categoryName(c: CategoryFilter): string {
  return c === "none" ? UNCATEGORIZED_LABEL : CATEGORIES[c];
}

/** Fixed order = fixed colour slot per category, whatever the ranking. */
const CATEGORY_ORDER: CategoryFilter[] = [...(Object.keys(CATEGORIES) as CategoryKey[]), "none"];

function sum<T>(rows: T[], amount: (row: T) => number): number {
  return rows.reduce((total, row) => total + amount(row), 0);
}

function groupTotals<T>(rows: T[], key: (row: T) => string | number, amount: (row: T) => number): Map<string | number, number> {
  const totals = new Map<string | number, number>();
  for (const row of rows) totals.set(key(row), (totals.get(key(row)) ?? 0) + amount(row));
  return totals;
}

// --- Formatting -------------------------------------------------------------------------------

const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

function monthParts(key: string): { year: number; month: number } {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}

function shiftMonth(key: string, delta: number): string {
  const { year, month } = monthParts(key);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function daysInMonth(key: string): number {
  const { year, month } = monthParts(key);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMonth(ymd: string): string {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

function weekdayDate(ymd: string): string {
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${dayMonth(ymd)}`;
}

/** Short axis/readout figures: 1250000 -> "1,25tr", 350000 -> "350k". */
function compactVnd(amount: number): string {
  if (amount >= 1_000_000) return `${trimDecimals(amount / 1_000_000)}tr`;
  if (amount >= 1_000) return `${trimDecimals(amount / 1_000)}k`;
  return `${amount}đ`;
}

function trimDecimals(value: number): string {
  return (Math.round(value * 100) / 100).toString().replace(".", ",");
}

/** "+12%" / "-8%", or null when there is nothing to compare with. */
function change(current: number, previous: number): { text: string; up: boolean } | null {
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, up: pct > 0 };
}

// --- DOM helpers ------------------------------------------------------------------------------

type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((ev: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === "function") el.addEventListener(name.slice(2), value);
    // Through CSSOM: the CSP (web/_headers) blocks style attributes in markup.
    else if (name === "style" && typeof value === "string") el.style.cssText = value;
    else if (value === true) el.setAttribute(name, "");
    else if (value !== false) el.setAttribute(name, value);
  }
  for (const child of children) if (child !== null && child !== false && child !== undefined) el.append(child);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag: string, attrs: Record<string, string | number>, ...children: Node[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  el.append(...children);
  return el;
}

// --- Rendering --------------------------------------------------------------------------------

const root = document.getElementById("app")!;

function render(): void {
  const { data } = state;
  if (state.error && !data) {
    root.replaceChildren(h("div", { class: "page alone" }, errorView(state.error)));
    return;
  }
  if (!data) {
    root.replaceChildren(skeleton());
    return;
  }
  const view = h("div", { class: state.loading ? "page is-loading" : "page" }, header(data), memberChips(data));
  if (state.error) view.append(errorView(state.error));
  else view.append(...sections(data));
  root.replaceChildren(view);
}

function header(data: MonthResponse): HTMLElement {
  const shown = state.month ?? data.month;
  const { year, month } = monthParts(shown);
  const canPrev = shown > data.firstMonth;
  const canNext = shown < data.currentMonth;
  const go = (delta: number) => () => {
    haptic();
    void load(shiftMonth(shown, delta));
  };
  return h(
    "header",
    { class: "month-nav" },
    h("button", { class: "nav-btn", "aria-label": "Tháng trước", disabled: !canPrev, onclick: go(-1) }, chevron("left")),
    h("h1", {}, `Tháng ${month}/${year}`),
    h("button", { class: "nav-btn", "aria-label": "Tháng sau", disabled: !canNext, onclick: go(1) }, chevron("right")),
  );
}

function chevron(direction: "left" | "right"): SVGElement {
  const d = direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7";
  return s("svg", { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true" }, s("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 2.25, "stroke-linecap": "round", "stroke-linejoin": "round" }));
}

/** "Cả nhóm", the viewer, then everyone else by this month's total. */
function memberChips(data: MonthResponse): HTMLElement {
  const totals = groupTotals(data.expenses, (e) => e.userId, (e) => e.amount);
  const others = data.members
    .filter((m) => m.id !== data.viewerId && totals.has(m.id))
    .sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0));
  const chip = (label: string, member: number | null) =>
    h(
      "button",
      {
        class: "chip",
        "aria-pressed": String(state.member === member),
        onclick: () => {
          if (state.member === member) return;
          haptic();
          Object.assign(state, { member, day: null, category: null, listLimit: LIST_PAGE });
          render();
        },
      },
      label,
    );
  return h("nav", { class: "chips", "aria-label": "Xem theo" }, chip("Cả nhóm", null), chip("Của tôi", data.viewerId), ...others.map((m) => chip(m.name, m.id)));
}

function sections(data: MonthResponse): HTMLElement[] {
  const mine = state.member === null ? data.expenses : data.expenses.filter((e) => e.userId === state.member);
  const previous = state.member === null ? data.previous : data.previous.filter((p) => p.userId === state.member);
  if (mine.length === 0) {
    const who = state.member === null ? "Nhóm" : state.member === data.viewerId ? "Bạn" : nameOf(data, state.member);
    return [h("section", { class: "card empty" }, h("p", {}, `${who} chưa có khoản chi nào trong tháng ${monthParts(data.month).month}.`))];
  }
  return [
    totalCard(data, mine, sum(previous, (p) => p.total)),
    dailyCard(data, state.category === null ? mine : mine.filter((e) => categoryOf(e) === state.category)),
    categoryCard(mine, previous),
    state.member === null ? memberCard(data) : null,
    listCard(data, mine),
  ].filter((el): el is HTMLElement => el !== null);
}

function nameOf(data: MonthResponse, id: number): string {
  return data.members.find((m) => m.id === id)?.name ?? "?";
}

function sectionTitle(text: string, aside?: Child): HTMLElement {
  return h("div", { class: "card-title" }, h("h2", {}, text), aside);
}

function totalCard(data: MonthResponse, rows: ApiExpense[], previousTotal: number): HTMLElement {
  const total = sum(rows, (e) => e.amount);
  const delta = change(total, previousTotal);
  // "so với 1-16/10" mid-month (the API cut the previous month at the same day), else "so với tháng 10".
  const [py, pm, pd] = data.previousThrough.split("-").map(Number) as [number, number, number];
  const wholeMonth = pd === new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const versus = wholeMonth ? `tháng ${pm}` : `1-${pd}/${pm}`;
  const card = h(
    "section",
    { class: "card total" },
    h("p", { class: "eyebrow" }, state.member === null ? "Cả nhóm đã chi" : state.member === data.viewerId ? "Bạn đã chi" : `${nameOf(data, state.member)} đã chi`),
    h("p", { class: "hero" }, formatVnd(total)),
    h(
      "p",
      { class: "meta" },
      `${rows.length} khoản`,
      delta && " · ",
      delta && h("span", { class: delta.up ? "delta up" : "delta down" }, delta.up ? "▲ " : "▼ ", delta.text.replace(/^[+-]/, "")),
      delta && ` so với ${versus}`,
    ),
  );
  // The budget is the group's and is set for the current month, so it only applies there.
  if (state.member === null && data.budget !== null && data.month === data.currentMonth) card.append(budgetBar(total, data.budget));
  return card;
}

function budgetBar(spent: number, budget: number): HTMLElement {
  const used = Math.floor((spent * 100) / budget);
  const level = used >= 100 ? "critical" : used >= 80 ? "warning" : "good";
  const left = budget - spent;
  return h(
    "div",
    { class: `budget ${level}` },
    h(
      "div",
      { class: "budget-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.min(used, 100)), "aria-label": "Ngân sách đã dùng" },
      h("span", { style: `width:${Math.min(used, 100)}%` }),
    ),
    h(
      "p",
      { class: "budget-text" },
      h("span", { class: "budget-status" }, level === "good" ? "" : "⚠ ", `${used}% ngân sách ${formatVnd(budget)}`),
      h("span", {}, left >= 0 ? `còn ${formatVnd(left)}` : `vượt ${formatVnd(-left)}`),
    ),
  );
}

function dailyCard(data: MonthResponse, rows: ApiExpense[]): HTMLElement {
  const days = daysInMonth(data.month);
  const byDay = groupTotals(rows, (e) => e.date, (e) => e.amount);
  const isCurrent = data.month === data.currentMonth;
  const lastDay = isCurrent ? Number(data.today.slice(8, 10)) : days;
  const total = sum(rows, (e) => e.amount);
  const values = Array.from({ length: days }, (_, i) => byDay.get(`${data.month}-${String(i + 1).padStart(2, "0")}`) ?? 0);
  const max = Math.max(...values, 1);

  // With a category picked, the bars are that category's spending, in its colour.
  const of = state.category === null ? "" : ` · ${categoryName(state.category)}`;
  const readout =
    state.day !== null
      ? h("p", { class: "readout" }, h("strong", {}, formatVnd(byDay.get(state.day) ?? 0)), ` · ${weekdayDate(state.day)}${of}`)
      : h("p", { class: "readout" }, h("strong", {}, formatVnd(Math.round(total / lastDay))), ` trung bình mỗi ngày${of}`);

  // Geometry in viewBox units; the SVG scales to the card's width.
  const W = 340;
  const H = 132;
  const top = 14;
  const bottom = 18;
  const plot = H - top - bottom;
  const slot = W / days;
  const barW = Math.max(2, slot - 2); // 2px surface gap between adjacent bars
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "bars", role: "img", "aria-label": `Chi tiêu theo ngày${of}, cao nhất ${formatVnd(max)}` }) as SVGSVGElement;
  if (state.category !== null) svg.dataset.series = state.category;
  svg.append(
    s("line", { x1: 0, x2: W, y1: top, y2: top, class: "grid" }),
    s("text", { x: 0, y: top - 4, class: "axis-label" }, document.createTextNode(compactVnd(max))),
    s("line", { x1: 0, x2: W, y1: top + plot, y2: top + plot, class: "baseline" }),
  );
  values.forEach((value, i) => {
    const day = i + 1;
    const ymd = `${data.month}-${String(day).padStart(2, "0")}`;
    const x = i * slot + (slot - barW) / 2;
    const future = isCurrent && day > lastDay;
    const height = value > 0 ? Math.max(3, (value / max) * plot) : 0;
    const selected = state.day === ymd;
    const dimmed = state.day !== null && !selected;
    const group = s("g", { class: `bar${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}${future ? " future" : ""}` });
    if (height > 0) group.append(s("path", { d: roundedTop(x, top + plot - height, barW, height, Math.min(3, barW / 2)) }));
    if (ymd === data.today) group.append(s("circle", { cx: x + barW / 2, cy: top + plot + 5, r: 1.6, class: "today" }));
    // The hit target is the whole column, wider and taller than the bar.
    const hit = s("rect", { x: i * slot, y: 0, width: slot, height: H, class: "hit" });
    if (value > 0) {
      hit.setAttribute("tabindex", "0");
      hit.setAttribute("role", "button");
      hit.setAttribute("aria-label", `${weekdayDate(ymd)}: ${formatVnd(value)}`);
      const pick = () => {
        haptic();
        Object.assign(state, { day: selected ? null : ymd, listLimit: LIST_PAGE });
        render();
      };
      hit.addEventListener("click", pick);
      hit.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") {
          ev.preventDefault();
          pick();
        }
      });
    }
    group.append(hit);
    svg.append(group);
  });
  for (const day of axisDays(days)) {
    const x = (day - 1) * slot + slot / 2;
    const anchor = day === 1 ? "start" : day === days ? "end" : "middle";
    svg.append(s("text", { x: day === 1 ? (day - 1) * slot : day === days ? W : x, y: H - 2, "text-anchor": anchor, class: "axis-label" }, document.createTextNode(String(day))));
  }
  return h("section", { class: "card" }, sectionTitle("Theo ngày"), readout, svg);
}

function axisDays(days: number): number[] {
  return [1, 5, 10, 15, 20, 25, days].filter((d, i, all) => d <= days && (d === days || all[i + 1]! - d >= 3 || d === 1));
}

/** A bar with rounded top corners, flat on the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function categoryCard(rows: ApiExpense[], previous: MonthResponse["previous"]): HTMLElement {
  const totals = groupTotals(rows, categoryOf, (e) => e.amount);
  const before = groupTotals(previous, categoryOf, (p) => p.total);
  const total = sum(rows, (e) => e.amount);
  const ranked = CATEGORY_ORDER.filter((c) => totals.has(c)).sort((a, b) => totals.get(b)! - totals.get(a)!);
  const max = totals.get(ranked[0]!) ?? 1;
  const list = h("ul", { class: "rows" });
  for (const c of ranked) {
    const value = totals.get(c)!;
    const delta = change(value, before.get(c) ?? 0);
    const active = state.category === c;
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          {
            class: `row${active ? " active" : ""}${state.category !== null && !active ? " dimmed" : ""}`,
            "aria-pressed": String(active),
            onclick: () => {
              haptic();
              Object.assign(state, { category: active ? null : c, listLimit: LIST_PAGE });
              render();
            },
          },
          h("span", { class: "row-line" }, h("span", { class: "swatch", "data-cat": c }), h("span", { class: "row-label" }, categoryName(c)), h("span", { class: "row-value" }, formatVnd(value))),
          h(
            "span",
            { class: "row-line sub" },
            h("span", { class: "meter" }, h("span", { "data-cat": c, style: `width:${(value / max) * 100}%` })),
            h("span", { class: "row-note" }, `${Math.round((value / total) * 100)}%`, delta && ` · ${delta.up ? "▲" : "▼"} ${delta.text.replace(/^[+-]/, "")}`),
          ),
        ),
      ),
    );
  }
  return h("section", { class: "card" }, sectionTitle("Theo loại", h("span", { class: "hint" }, "Chạm để lọc")), list);
}

function memberCard(data: MonthResponse): HTMLElement {
  const totals = groupTotals(data.expenses, (e) => e.userId, (e) => e.amount);
  const counts = groupTotals(data.expenses, (e) => e.userId, () => 1);
  const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!) as number[];
  const max = totals.get(ranked[0]!) ?? 1;
  const list = h("ul", { class: "rows" });
  ranked.forEach((id, i) => {
    const value = totals.get(id)!;
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          {
            class: "row",
            onclick: () => {
              haptic();
              Object.assign(state, { member: id, day: null, category: null, listLimit: LIST_PAGE });
              render();
              window.scrollTo({ top: 0, behavior: "smooth" });
            },
          },
          h("span", { class: "row-line" }, h("span", { class: "rank" }, String(i + 1)), h("span", { class: "row-label" }, id === data.viewerId ? `${nameOf(data, id)} (bạn)` : nameOf(data, id)), h("span", { class: "row-value" }, formatVnd(value))),
          h("span", { class: "row-line sub" }, h("span", { class: "meter" }, h("span", { class: "accent", style: `width:${(value / max) * 100}%` })), h("span", { class: "row-note" }, `${counts.get(id)} khoản`)),
        ),
      ),
    );
  });
  return h("section", { class: "card" }, sectionTitle("Thành viên"), list);
}

function listCard(data: MonthResponse, rows: ApiExpense[]): HTMLElement {
  const filtered = rows.filter((e) => (state.day === null || e.date === state.day) && (state.category === null || categoryOf(e) === state.category));
  const filters: HTMLElement[] = [];
  const clear = (patch: Partial<State>) => () => {
    haptic();
    Object.assign(state, patch, { listLimit: LIST_PAGE });
    render();
  };
  if (state.day !== null) filters.push(h("button", { class: "chip removable", "aria-label": `Bỏ lọc ngày ${dayMonth(state.day)}`, onclick: clear({ day: null }) }, `Ngày ${dayMonth(state.day)}`, closeIcon()));
  if (state.category !== null) filters.push(h("button", { class: "chip removable", "aria-label": `Bỏ lọc ${categoryName(state.category)}`, onclick: clear({ category: null }) }, categoryName(state.category), closeIcon()));

  const card = h("section", { class: "card list" }, sectionTitle("Chi tiết", h("span", { class: "hint" }, `${filtered.length} khoản`)));
  if (filters.length > 0) card.append(h("div", { class: "filters" }, ...filters));
  if (filtered.length === 0) {
    card.append(h("p", { class: "muted" }, "Không có khoản chi nào khớp bộ lọc."));
    return card;
  }

  const shown = filtered.slice(0, state.listLimit);
  const dayTotals = groupTotals(filtered, (e) => e.date, (e) => e.amount);
  let currentDay = "";
  let group: HTMLUListElement | null = null;
  for (const e of shown) {
    if (e.date !== currentDay) {
      currentDay = e.date;
      group = h("ul", { class: "day-items" });
      card.append(h("div", { class: "day" }, h("h3", { class: "day-head" }, h("span", {}, weekdayDate(e.date)), h("span", {}, formatVnd(dayTotals.get(e.date) ?? 0))), group));
    }
    const who = state.member === null ? nameOf(data, e.userId) : null;
    const c = categoryOf(e);
    group!.append(
      h(
        "li",
        { class: "item" },
        h("span", { class: "swatch", "data-cat": c }),
        h("span", { class: "item-main" }, h("span", { class: e.note ? "item-note" : "item-note muted" }, e.note || "Không ghi chú"), h("span", { class: "item-sub" }, [who, categoryName(c)].filter(Boolean).join(" · "))),
        h("span", { class: "item-amount" }, formatVnd(e.amount)),
      ),
    );
  }
  if (filtered.length > shown.length) {
    card.append(
      h(
        "button",
        {
          class: "more",
          onclick: () => {
            state.listLimit += LIST_PAGE * 2;
            render();
          },
        },
        `Xem thêm ${Math.min(filtered.length - shown.length, LIST_PAGE * 2)} khoản`,
      ),
    );
  }
  return card;
}

function closeIcon(): SVGElement {
  return s("svg", { viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true" }, s("path", { d: "M6 6l12 12M18 6L6 18", stroke: "currentColor", "stroke-width": 2.5, "stroke-linecap": "round" }));
}

function skeleton(): HTMLElement {
  return h(
    "div",
    { class: "page", "aria-busy": "true" },
    h("div", { class: "skeleton bar-sm" }),
    h("div", { class: "skeleton chips-sk" }),
    h("div", { class: "skeleton card-sk tall" }),
    h("div", { class: "skeleton card-sk" }),
    h("div", { class: "skeleton card-sk" }),
  );
}

const ERRORS: Record<ApiErrorCode | "network", { title: string; text: string; retry: boolean }> = {
  unauthorized: { title: "Mở từ Telegram", text: "Trang này chỉ xem được khi mở từ bot trong Telegram.", retry: false },
  expired: { title: "Phiên đã hết hạn", text: "Hãy đóng rồi mở lại ứng dụng.", retry: false },
  not_member: { title: "Không có quyền xem", text: "Chỉ thành viên trong nhóm mới xem được chi tiêu.", retry: false },
  bad_month: { title: "Không có tháng này", text: "Hãy chọn một tháng khác.", retry: false },
  unavailable: { title: "Chưa xác nhận được", text: "Telegram chưa trả lời. Thử lại sau giây lát.", retry: true },
  network: { title: "Không tải được dữ liệu", text: "Kiểm tra kết nối mạng rồi thử lại.", retry: true },
};

function errorView(code: ApiErrorCode | "network"): HTMLElement {
  const { title, text, retry } = ERRORS[code];
  return h(
    "section",
    { class: "card message", role: "alert" },
    h("h2", {}, title),
    h("p", {}, text),
    retry && h("button", { class: "primary", onclick: () => void load(state.month) }, "Thử lại"),
  );
}

// --- Start ------------------------------------------------------------------------------------

applyTheme();
tg?.onEvent("themeChanged", applyTheme);
tg?.ready();
tg?.expand();
void load(null);
