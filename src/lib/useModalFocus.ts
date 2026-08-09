import { type RefObject, useId, useLayoutEffect, useRef } from "react";

const modalDialogSelector = [
  '[role="dialog"][aria-modal="true"]:not([aria-hidden="true"]):not([inert])',
  '[role="alertdialog"][aria-modal="true"]:not([aria-hidden="true"]):not([inert])'
].join(",");

const modalFocusPortalSelector = '[data-modal-focus-portal="true"]';

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(",");

interface ModalFocusOptions {
  enabled?: boolean;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function isAvailableFocusTarget(element: HTMLElement) {
  const style = window.getComputedStyle(element);

  return element.tabIndex >= 0
    && !element.matches(":disabled")
    && !element.closest('[aria-hidden="true"], [hidden], [inert]')
    && style.display !== "none"
    && style.visibility !== "hidden";
}

function modalFocusPortals(dialog: HTMLElement) {
  const owner = dialog.dataset.modalFocusScope;

  if (!owner) {
    return [];
  }

  return Array.from(document.querySelectorAll<HTMLElement>(modalFocusPortalSelector))
    .filter((portal) => portal.dataset.modalFocusOwner === owner);
}

function focusableElements(dialog: HTMLElement) {
  const focusScopes = [
    dialog,
    ...modalFocusPortals(dialog)
  ];

  return focusScopes.flatMap((scope) =>
    Array.from(scope.querySelectorAll<HTMLElement>(focusableSelector)).filter(isAvailableFocusTarget)
  );
}

function focusIsInsideModalScope(dialog: HTMLElement, target: Element | null) {
  return Boolean(
    target
    && (
      dialog.contains(target)
      || modalFocusPortals(dialog).some((portal) => portal.contains(target))
    )
  );
}

function isTopmostModal(dialog: HTMLElement) {
  const openDialogs = Array.from(document.querySelectorAll<HTMLElement>(modalDialogSelector));
  return openDialogs.at(-1) === dialog;
}

export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  { enabled = true, fallbackFocusRef, returnFocusRef }: ModalFocusOptions = {}
) {
  const capturedReturnFocusRef = useRef<HTMLElement | null>(null);
  const lastDialogRef = useRef<HTMLElement | null>(null);
  const restoreRequestRef = useRef(0);
  const focusScopeId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!enabled || !dialog) {
      return undefined;
    }
    const activeDialog: HTMLElement = dialog;
    const fallbackFocus = fallbackFocusRef?.current;
    restoreRequestRef.current += 1;
    lastDialogRef.current = activeDialog;
    activeDialog.dataset.modalFocusScope = focusScopeId;

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!capturedReturnFocusRef.current?.isConnected) {
      const requestedReturnFocus = returnFocusRef?.current;

      capturedReturnFocusRef.current = requestedReturnFocus?.isConnected
        ? requestedReturnFocus
        : (
          activeElement
          && activeElement !== document.body
          && isAvailableFocusTarget(activeElement)
          && !activeDialog.contains(activeElement)
            ? activeElement
            : null
        );
    }
    if (returnFocusRef && !returnFocusRef.current?.isConnected) {
      returnFocusRef.current = capturedReturnFocusRef.current;
    }

    return () => {
      const restoreRequest = ++restoreRequestRef.current;

      window.requestAnimationFrame(() => {
        if (restoreRequest !== restoreRequestRef.current) {
          return;
        }
        const returnFocus = returnFocusRef?.current ?? capturedReturnFocusRef.current;
        const focusTarget = returnFocus?.isConnected ? returnFocus : fallbackFocus;
        const remainingDialog = Array.from(document.querySelectorAll<HTMLElement>(modalDialogSelector)).at(-1) ?? null;

        if (
          activeDialog.isConnected
          || (remainingDialog && (!focusTarget || !focusIsInsideModalScope(remainingDialog, focusTarget)))
        ) {
          return;
        }

        if (focusTarget?.isConnected) {
          focusTarget.focus({ preventScroll: true });
        }
        capturedReturnFocusRef.current = null;
        if (returnFocusRef) {
          returnFocusRef.current = null;
        }
      });
    };
  }, [dialogRef, enabled, fallbackFocusRef, focusScopeId, returnFocusRef]);

  useLayoutEffect(() => {
    const fallbackFocus = fallbackFocusRef?.current;

    return () => {
      const activeDialog = lastDialogRef.current;
      const restoreRequest = ++restoreRequestRef.current;

      window.requestAnimationFrame(() => {
        if (restoreRequest !== restoreRequestRef.current) {
          return;
        }
        const returnFocus = returnFocusRef?.current ?? capturedReturnFocusRef.current;
        const focusTarget = returnFocus?.isConnected ? returnFocus : fallbackFocus;
        const remainingDialog = Array.from(document.querySelectorAll<HTMLElement>(modalDialogSelector)).at(-1) ?? null;

        if (
          activeDialog?.isConnected
          || (remainingDialog && (!focusTarget || !focusIsInsideModalScope(remainingDialog, focusTarget)))
        ) {
          return;
        }

        if (focusTarget?.isConnected) {
          focusTarget.focus({ preventScroll: true });
        }
        capturedReturnFocusRef.current = null;
        if (returnFocusRef) {
          returnFocusRef.current = null;
        }
      });
    };
  }, [fallbackFocusRef, returnFocusRef]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!enabled || !dialog) {
      return undefined;
    }
    const activeDialog: HTMLElement = dialog;

    if (activeDialog.isConnected && isTopmostModal(activeDialog)) {
      const requestedInitialFocus = activeDialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      const initialFocus = requestedInitialFocus && isAvailableFocusTarget(requestedInitialFocus)
        ? requestedInitialFocus
        : focusableElements(activeDialog)[0] ?? activeDialog;

      initialFocus.focus({ preventScroll: true });
    }

    function containKeyboardFocus(event: KeyboardEvent) {
      if (event.key !== "Tab" || event.defaultPrevented || !isTopmostModal(activeDialog)) {
        return;
      }

      const candidates = focusableElements(activeDialog);
      if (!candidates.length) {
        event.preventDefault();
        activeDialog.focus({ preventScroll: true });
        return;
      }

      const first = candidates[0];
      const last = candidates.at(-1)!;
      const current = document.activeElement;

      if (!focusIsInsideModalScope(activeDialog, current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", containKeyboardFocus, true);

    return () => {
      document.removeEventListener("keydown", containKeyboardFocus, true);
    };
  }, [dialogRef, enabled]);
}
