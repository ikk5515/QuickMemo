# QuickMemo Bases compatibility contract

This document records the exact client-side Bases surface implemented for the
Obsidian Core 1.13.7 compatibility target. The reference behavior comes from
the official [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)
and [Bases functions](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Functions.md)
documentation inspected on 2026-08-23.

## Security and execution model

- Formulas and filters run in the bounded QuickMemo parser/interpreter. They do
  not use `eval`, `Function`, a browser realm, network access, or plugin code.
- Decrypted properties, paths, links, and derived backlinks stay in the existing
  in-memory Base/knowledge projections and worker messages. Formula evaluation
  adds no local or remote plaintext persistence.
- Prototype keys (`__proto__`, `constructor`, and `prototype`) and executable URL
  schemes are rejected. Formula-created external links allow only `http` and
  `https`.
- Regular expressions use a deliberately smaller, statically checked JavaScript
  subset. Patterns are capped at 256 characters and inputs at 10,000 characters;
  backreferences, lookarounds, nested repetition, repeated alternation, multiple
  global wildcards, and repetitions above 1,000 are rejected. Replacement
  expansion (including `$1`, `$&`, ``$` ``, and `$'`) is budgeted before the
  native replace call. This is not advertised as arbitrary-JavaScript-regex
  compatibility because native `RegExp` has no synchronous wall-clock interrupt.
  Every Base containing a regex literal is therefore materialized in a
  disposable module Worker even below the normal 250-entry worker threshold.
  The client terminates that Worker after 2 seconds and renders no partial rows.
- Expressions are capped at 10,000 characters, 2,000 tokens, 64 levels, and
  10,000 execution steps. Literal collections are capped at 256 items; result
  lists at 10,000 items; result objects at 1,000 keys; aggregate result text at
  1,000,000 characters; map/filter/reduce at 5,000 iterations. String-producing
  operations stop before 100,000 characters.

## Implemented syntax and values

- Number, string, boolean, and null literals.
- Bounded list literals (`[1, 2]`), object literals (`{name: "Memo"}`), numeric
  list indexing, quoted object access, and dot access.
- Arithmetic, comparison, boolean, unary, parenthesized, and lazy `if`
  expressions. Date/date subtraction and date/duration addition or subtraction
  follow the documented operator meanings.
- Typed Date, Duration, Link, File, HTML, Image, Icon, RegExp, Object, and nested
  List values. ISO-like YAML property strings become dates; quoted Wikilink
  properties become links.
- Calendar month/year durations remain separate from fixed milliseconds, so
  `date("2024-12-01") + "1M"` is not approximated as thirty days.

## Implemented functions and methods

- Global: `escapeHTML`, `date`, `duration`, `file`, `html`, `image`, `icon`,
  `if`, `link`, `list`, `max`, `min`, `now`, `number`, `random`, and `today`,
  plus the existing compatibility helpers `string`, `boolean`, `abs`, `ceil`,
  `floor`, and `round`.
- Any: `isEmpty`, `isTruthy`, `isType`, and `toString`.
- Date: documented fields, `date`, `format`, `time`, and `relative`. Formatting
  supports bracket literals and the bounded UTC/English token set `YYYY`, `YY`,
  `MMMM`, `MMM`, `MM`, `M`, `DDDD`, `DDD`, `DD`, `D`, `dddd`, `ddd`, `dd`, `d`,
  `HH`, `H`, `hh`, `h`, `mm`, `m`, `ss`, `s`, `SSS`, `A`, `a`, `Q`, `X`, `x`,
  and `Z`. `relative` is an English, bounded approximation.
- String: `contains`, `containsAll`, `containsAny`, `endsWith`, `isEmpty`,
  `lower`, `replace`, `repeat`, `reverse`, `slice`, `split`, `startsWith`,
  `title`, and `trim`. `replace` and `split` accept literal strings or the safe
  RegExp subset; capture references are supported for RegExp replacement.
- Number: `abs`, `ceil`, `floor`, `round`, and `toFixed`.
- List: numeric indexing, `contains`, `containsAll`, `containsAny`, `filter`,
  `flat`, `isEmpty`, `join`, `map`, `reduce`, `reverse`, `slice`, `sort`, and
  `unique`, plus Base summary helpers `sum`, `mean`, `min`, `max`, `median`, and
  `stddev`.
- Object: property access, `isEmpty`, `keys`, and `values`.
- Link: `asFile`, `linksTo`; typed path/display access and File/Link equality.
- File: documented fields and `asLink`, `hasLink`, `hasProperty`, `hasTag`, and
  `inFolder`.
- RegExp: `matches`.

`random()` returns a number in `[0, 1)`. A new cryptographically seeded view
materialization produces new row-scoped streams, matching the documented
refresh-on-view-load behavior. The optional evaluation seed exists only for
tests/replay and is not persisted.

## File properties

`file.backlinks`, `file.basename`, `file.ctime`, `file.embeds`, `file.ext`,
`file.file`, `file.folder`, `file.links`, `file.mtime`, `file.name`, `file.path`,
`file.properties`, `file.size`, and `file.tags` are materialized for every
visible accepted vault entry type.

- Links are resolved with the same path/alias resolution index used by the
  knowledge layer. Backlinks are derived transiently from the ACL-filtered entry
  set and capped at 32,768 examined occurrences. No excluded entry is introduced
  into the Base projection.
- Embeds come only from parsed links explicitly marked as embedded.
- `file.size` uses a validated decrypted byte-size projection when supplied. For
  text-backed entries it computes the exact UTF-8 byte length without allocating
  a second byte buffer. It remains empty for an asset whose decrypted byte size
  is not present; encrypted ciphertext size is never mislabeled as file size.
- Note properties remain empty for non-Markdown files, while File properties are
  available for all accepted entry kinds.

## Typed rendering and context

- `html()` never creates a raw DOM injection. The React renderer parses the
  value into a 1,000-node/16-level tree, keeps only a small text-formatting tag
  allowlist, discards attributes, and permits only `http`/`https` anchors with
  `noopener noreferrer`. It does not use `dangerouslySetInnerHTML`.
- `image()` accepts a vault path or `http`/`https` URL. To avoid an implicit
  cross-origin request or tracking pixel, an external value renders as an
  explicit safe link rather than auto-loading. A vault image renders as a named
  placeholder until the caller supplies an authorized decrypted-asset renderer.
- `icon()` is a typed value and link labels preserve it. The current renderer
  uses a generic accessible glyph with the requested icon name; it does not load
  arbitrary SVG or plugin code.
- `BaseView.evaluationContext` carries the Base file, embedding note/Canvas, or
  active main-pane file selected by the caller. `this.file.*`, including nested
  `this.file.properties.*`, is then evaluated from that transient ACL-filtered
  projection. The context is passed to the worker when large Bases are
  materialized and is never persisted by the Base engine.
- `file(path)`, `link.asFile()`, and `link.linksTo(file)` resolve against the same
  bounded internal-link index used for visible Base entries. They cannot resolve
  an external URL or an entry absent from the accepted input set.

## Intentionally unavailable or partial

- Arbitrary JavaScript regular expressions remain intentionally unavailable.
  The safe subset omits lookaround, backreferences, nested/ambiguous repetition,
  `d`/`v` flags, and other shapes that cannot be bounded before native execution.
- Date formatting is not a full Moment implementation: unsupported locale,
  timezone, week-year/week-number, ordinal, era, and extended fractional-second
  tokens remain literal. Formatting and date fields currently use UTC and
  English names; `relative()` is not locale-aware.
- HTML is a formatting subset, not Obsidian's complete HTML rendering behavior.
  External images are opt-in links, vault images need an authorized asset
  adapter, and icons use a generic glyph rather than the complete Lucide set.
- The engine exposes `this.file` only when the host passes the correct
  `evaluationContext`. Automatic active-pane/sidebar tracking remains a host
  integration responsibility. `this` object coercion such as `author == this`
  is not implemented; use `author == this.file`.
- Plugin-provided functions and plugin-provided view types are not loaded or
  executed. Community Plugin API/binary compatibility is outside the target.
- Formula RegExp support does not enable regex in the shared Vault search-query
  parser; that path remains separately disabled until its cancellable worker
  contract is available.

Unavailable items produce explicit compatibility diagnostics or an empty typed
field where the source projection genuinely lacks data; they are not silently
executed through JavaScript.
