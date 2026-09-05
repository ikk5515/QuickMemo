/** Shared by the outline index and reading renderer, including duplicate titles. */
export function createMarkdownHeadingSlugger() {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return (value: string) => {
    const base = value.normalize("NFC").trim().toLocaleLowerCase()
      .replace(/\s+/gu, "-").replace(/[^\p{L}\p{M}\p{N}_-]/gu, "") || "section";
    let suffix = nextSuffix.get(base) ?? 0;
    let slug = suffix ? `${base}-${suffix}` : base;
    while (used.has(slug)) { suffix += 1; slug = `${base}-${suffix}`; }
    used.add(slug);
    nextSuffix.set(base, suffix + 1);
    return slug;
  };
}
