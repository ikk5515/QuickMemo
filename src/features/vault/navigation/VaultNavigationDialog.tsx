import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { rankFuzzyItems } from "./fuzzy";
import {
  navigationActivationFromEvent,
  type NavigationActivationMetadata
} from "./types";
import "./navigation.css";

interface VaultNavigationDialogProps<T> {
  closeOnActivate?: boolean;
  emptyLabel: string;
  getItemKey: (item: T) => string;
  getSearchText: (item: T) => string;
  inputLabel: string;
  initialQuery?: string;
  isItemDisabled?: (item: T) => boolean;
  items: readonly T[];
  listLabel: string;
  onActivate: (item: T, metadata: NavigationActivationMetadata) => void;
  onOpenChange: (open: boolean) => void;
  onQueryChange?: (query: string) => void;
  open: boolean;
  placeholder: string;
  renderItem: (item: T, active: boolean) => ReactNode;
  title: string;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const NAVIGATION_RESULT_LIMIT = 160;

export function VaultNavigationDialog<T>({
  closeOnActivate = true,
  emptyLabel,
  getItemKey,
  getSearchText,
  inputLabel,
  initialQuery = "",
  isItemDisabled,
  items,
  listLabel,
  onActivate,
  onOpenChange,
  onQueryChange,
  open,
  placeholder,
  renderItem,
  title
}: VaultNavigationDialogProps<T>) {
  const instanceId = useId().replace(/:/gu, "");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const rankedItems = useMemo(
    () => rankFuzzyItems(items, query, getSearchText),
    [getSearchText, items, query]
  );
  const visibleItems = useMemo(
    () => rankedItems
      .slice(0, NAVIGATION_RESULT_LIMIT)
      .map((rankedItem) => rankedItem.item),
    [rankedItems]
  );
  const resultStatus = rankedItems.length > visibleItems.length
    ? `${rankedItems.length.toLocaleString("ko-KR")}개 결과 중 ${visibleItems.length.toLocaleString("ko-KR")}개 표시. 더 구체적으로 검색하면 나머지 결과를 찾을 수 있습니다.`
    : `${rankedItems.length.toLocaleString("ko-KR")}개 결과`;
  const activeItem = visibleItems[activeIndex];
  const activeOptionId = activeItem === undefined
    ? undefined
    : `${instanceId}-option-${activeIndex}`;

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setQuery(initialQuery);
      setActiveIndex(0);
      inputRef.current?.focus();
    }
    if (!open && wasOpenRef.current) {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }
    wasOpenRef.current = open;
  }, [initialQuery, open]);

  useEffect(() => () => {
    if (wasOpenRef.current) {
      previousFocusRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (activeIndex >= visibleItems.length) {
      setActiveIndex(Math.max(visibleItems.length - 1, 0));
    }
  }, [activeIndex, visibleItems.length]);

  useEffect(() => {
    if (!open || activeOptionId === undefined) {
      return;
    }
    const option = document.getElementById(activeOptionId);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId, open]);

  function close() {
    onOpenChange(false);
  }

  function activate(
    item: T,
    event: ReactKeyboardEvent<HTMLInputElement> | ReactMouseEvent<HTMLButtonElement>,
    source: NavigationActivationMetadata["source"]
  ) {
    if (isItemDisabled?.(item)) {
      return;
    }
    onActivate(item, navigationActivationFromEvent(event.nativeEvent, source));
    if (closeOnActivate) {
      close();
    }
  }

  function moveSelection(delta: number) {
    if (visibleItems.length === 0) {
      return;
    }
    setActiveIndex((current) => (current + delta + visibleItems.length) % visibleItems.length);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveSelection(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(visibleItems.length - 1, 0));
        break;
      case "Enter":
        if (activeItem !== undefined) {
          event.preventDefault();
          activate(activeItem, event, "keyboard");
        }
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && event.target !== inputRef.current) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.tabIndex >= 0);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="qm-vault-navigation-backdrop"
      data-testid="vault-navigation-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div
        aria-labelledby={`${instanceId}-title`}
        aria-modal="true"
        className="qm-vault-navigation-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="qm-vault-navigation-visually-hidden" id={`${instanceId}-title`}>
          {title}
        </h2>
        <div className="qm-vault-navigation-search">
          <span aria-hidden="true" className="qm-vault-navigation-search__icon">⌕</span>
          <input
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            aria-controls={`${instanceId}-listbox`}
            aria-expanded="true"
            aria-label={inputLabel}
            autoComplete="off"
            className="qm-vault-navigation-search__input"
            onChange={(event) => {
              const nextQuery = event.currentTarget.value;
              setQuery(nextQuery);
              setActiveIndex(0);
              onQueryChange?.(nextQuery);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder={placeholder}
            ref={inputRef}
            role="combobox"
            spellCheck="false"
            type="search"
            value={query}
          />
          {query.length > 0 ? (
            <button
              aria-label="검색어 지우기"
              className="qm-vault-navigation-search__clear"
              onClick={() => {
                setQuery("");
                setActiveIndex(0);
                onQueryChange?.("");
                inputRef.current?.focus();
              }}
              type="button"
            >
              ×
            </button>
          ) : null}
          <button
            aria-label={`${title} 닫기`}
            className="qm-vault-navigation-close"
            onClick={close}
            type="button"
          >
            Esc
          </button>
        </div>

        <p
          aria-atomic="true"
          aria-live="polite"
          className="qm-vault-navigation-visually-hidden"
          id={`${instanceId}-result-status`}
          role="status"
        >
          {resultStatus}
        </p>
        <div
          aria-describedby={`${instanceId}-result-status`}
          aria-label={listLabel}
          className="qm-vault-navigation-results"
          id={`${instanceId}-listbox`}
          role="listbox"
        >
          {visibleItems.length === 0 ? (
            <p className="qm-vault-navigation-empty">{emptyLabel}</p>
          ) : visibleItems.map((item, index) => {
            const disabled = isItemDisabled?.(item) ?? false;
            const active = index === activeIndex;
            return (
              <button
                aria-disabled={disabled || undefined}
                aria-posinset={index + 1}
                aria-selected={active}
                aria-setsize={rankedItems.length}
                className={`qm-vault-navigation-option${active ? " is-active" : ""}`}
                id={`${instanceId}-option-${index}`}
                key={getItemKey(item)}
                onClick={(event) => activate(item, event, "pointer")}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                role="option"
                tabIndex={-1}
                type="button"
              >
                {renderItem(item, active)}
              </button>
            );
          })}
        </div>

        <footer className="qm-vault-navigation-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> 선택</span>
          <span><kbd>↵</kbd> 열기</span>
          <span><kbd>Esc</kbd> 닫기</span>
        </footer>
      </div>
    </div>,
    document.body
  );
}
