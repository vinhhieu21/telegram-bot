// The fixed category list. Keys are stored in expenses.category; labels are shown to users.
// Adding a key is safe; renaming or removing one needs a migration for existing rows.

export const CATEGORIES = {
  an_uong: "Ăn uống",
  di_chuyen: "Di chuyển",
  mua_sam: "Mua sắm",
  giai_tri: "Giải trí",
  nha_hoa_don: "Nhà & hoá đơn",
  suc_khoe: "Sức khoẻ",
  khac: "Khác",
} as const;

export type CategoryKey = keyof typeof CATEGORIES;

/** Label for expenses the LLM has not classified yet (or could not). */
export const UNCATEGORIZED_LABEL = "Chưa phân loại";

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && Object.hasOwn(CATEGORIES, value);
}

export function categoryLabel(key: string | null): string {
  return isCategoryKey(key) ? CATEGORIES[key] : UNCATEGORIZED_LABEL;
}
