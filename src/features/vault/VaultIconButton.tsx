import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type Ref
} from "react";
import { createPortal } from "react-dom";

interface VaultIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
  tooltip: string;
  tooltipPlacement?: "right" | "bottom";
  ref?: Ref<HTMLButtonElement>;
}

/** An ordinary button whose hover/focus help is not clipped by scrolling panels. */
export function VaultIconButton({
  children,
  tooltip,
  tooltipPlacement = "right",
  ref,
  onBlur,
  onFocus,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  "aria-describedby": describedBy,
  ...props
}: VaultIconButtonProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const attachButton = useCallback((button: HTMLButtonElement | null) => {
    buttonRef.current = button;
    if (typeof ref === "function") ref(button);
    else if (ref) ref.current = button;
  }, [ref]);
  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const dismiss = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);
  const scheduleClose = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => setOpen(false), 120);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !tooltipRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const hint = tooltipRef.current.getBoundingClientRect();
    const left = tooltipPlacement === "right" ? anchor.right + 8 : anchor.left;
    const top = tooltipPlacement === "right"
      ? anchor.top + (anchor.height - hint.height) / 2
      : anchor.bottom + 6;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - hint.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - hint.height - 8))
    });
  }, [open, tooltip, tooltipPlacement]);
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismiss, open]);

  return <>
    <button
      {...props}
      aria-describedby={[describedBy, open ? id : null].filter(Boolean).join(" ") || undefined}
      onBlur={(event) => { dismiss(); onBlur?.(event); }}
      onFocus={(event) => {
        clearTimer();
        if (!touchRef.current) setOpen(true);
        onFocus?.(event);
      }}
      onPointerDown={(event) => {
        touchRef.current = event.pointerType === "touch";
        dismiss();
        onPointerDown?.(event);
      }}
      onPointerEnter={(event) => {
        touchRef.current = event.pointerType === "touch";
        clearTimer();
        if (!touchRef.current) timerRef.current = setTimeout(() => setOpen(true), 300);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => { scheduleClose(); onPointerLeave?.(event); }}
      ref={attachButton}
      type={props.type ?? "button"}
    >{children}</button>
    {open && createPortal(
      <span
        className="vault-icon-tooltip"
        id={id}
        ref={tooltipRef}
        role="tooltip"
        style={position}
      >{tooltip}</span>,
      document.body
    )}
  </>;
}
